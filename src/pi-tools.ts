import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";

const IMAGE_SNIFF_BYTES = 4_100;
const STREAMING_READ_MAX_OFFSET = 10_000;

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);

  try {
    if ((input.offset ?? 1) > STREAMING_READ_MAX_OFFSET) {
      return runPiReadTool(path, input, context);
    }
    if (await looksLikePotentialImage(path)) {
      return runPiReadTool(path, input, context);
    }

    return {
      content: [{
        type: "text",
        text: await readTextFileStreaming(path, input.offset, input.limit),
      }],
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

function runPiReadTool(
  path: string,
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  const tool = createReadTool(context.cwd);
  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

async function looksLikePotentialImage(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    return (
      (startsWithBytes(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0xf7)
      || isValidPngHeader(bytes)
      || startsWithAscii(bytes, 0, "GIF87a")
      || startsWithAscii(bytes, 0, "GIF89a")
      || (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP"))
      || isValidBmpHeader(bytes)
    );
  } finally {
    await handle.close();
  }
}

function startsWithBytes(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, value: string): boolean {
  if (buffer.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (buffer[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function isValidPngHeader(buffer: Buffer): boolean {
  return (
    startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && buffer.length >= 24
    && buffer.readUInt32BE(8) === 13
    && startsWithAscii(buffer, 12, "IHDR")
  );
}

function isValidBmpHeader(buffer: Buffer): boolean {
  if (!startsWithAscii(buffer, 0, "BM") || buffer.length < 26) return false;
  const declaredFileSize = buffer.readUInt32LE(2);
  const pixelDataOffset = buffer.readUInt32LE(10);
  const dibHeaderSize = buffer.readUInt32LE(14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = buffer.readUInt16LE(22);
    bitsPerPixel = buffer.readUInt16LE(24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = buffer.readUInt16LE(26);
    bitsPerPixel = buffer.readUInt16LE(28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

async function readTextFileStreaming(
  path: string,
  offset = 1,
  limit?: number,
): Promise<string> {
  const startLine = Math.max(0, offset - 1);
  const outputLineLimit = Math.min(limit ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
  const stream = createReadStream(path);
  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let currentLine = 0;
  let currentLineBytes = 0;
  let currentLineChunks: Buffer[] = [];
  let stopped = false;
  let moreLinesAvailable = false;
  let truncatedByBytes = false;
  let firstLineExceedsLimit = false;
  let lastByteWasNewline = false;
  let preserveTrailingNewline = false;

  const resetCurrentLine = () => {
    currentLineBytes = 0;
    currentLineChunks = [];
  };

  const appendCurrentLine = (segment: Buffer) => {
    if (currentLine < startLine || segment.length === 0) return;
    currentLineChunks.push(segment);
    currentLineBytes += segment.length;

    const separatorBytes = selectedLines.length > 0 ? 1 : 0;
    if (selectedBytes + separatorBytes + currentLineBytes <= DEFAULT_MAX_BYTES) return;

    truncatedByBytes = true;
    firstLineExceedsLimit = selectedLines.length === 0;
    moreLinesAvailable = true;
    stopped = true;
  };

  const finishCurrentLine = () => {
    if (currentLine < startLine) {
      currentLine++;
      resetCurrentLine();
      return;
    }

    if (selectedLines.length >= outputLineLimit) {
      moreLinesAvailable = true;
      stopped = true;
      return;
    }

    const line = currentLineChunks.length === 0
      ? ""
      : Buffer.concat(currentLineChunks, currentLineBytes).toString("utf8");
    const lineBytes = Buffer.byteLength(line, "utf8");
    const separatorBytes = selectedLines.length > 0 ? 1 : 0;
    if (selectedBytes + separatorBytes + lineBytes > DEFAULT_MAX_BYTES) {
      truncatedByBytes = true;
      firstLineExceedsLimit = selectedLines.length === 0;
      moreLinesAvailable = true;
      stopped = true;
      return;
    }

    selectedLines.push(line);
    selectedBytes += separatorBytes + lineBytes;
    currentLine++;
    resetCurrentLine();
  };

  readLoop: for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length > 0) lastByteWasNewline = chunk[chunk.length - 1] === 0x0a;
    let cursor = 0;

    while (!stopped && cursor < chunk.length) {
      if (selectedLines.length >= outputLineLimit && currentLine >= startLine) {
        moreLinesAvailable = true;
        stopped = true;
        break;
      }

      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline === -1 ? chunk.length : newline;
      appendCurrentLine(chunk.subarray(cursor, end));
      if (stopped || newline === -1) break;

      finishCurrentLine();
      cursor = newline + 1;
    }

    if (stopped) break readLoop;
  }

  if (!stopped) {
    if (lastByteWasNewline && currentLineBytes === 0) {
      preserveTrailingNewline = selectedLines.length > 0;
    } else {
      finishCurrentLine();
    }
  }

  if (selectedLines.length === 0 && currentLine <= startLine && !firstLineExceedsLimit) {
    throw new Error(`Offset ${offset} is beyond end of file (${currentLine} lines total)`);
  }

  if (firstLineExceedsLimit) {
    return `[Line ${offset} exceeds ${formatByteLimit(DEFAULT_MAX_BYTES)} limit. Use bash to inspect a bounded byte range.]`;
  }

  const text = `${selectedLines.join("\n")}${preserveTrailingNewline ? "\n" : ""}`;
  if (!moreLinesAvailable) return text;

  const endLine = startLine + selectedLines.length;
  const nextOffset = Math.max(startLine + 1, endLine + 1);
  const byteNotice = truncatedByBytes
    ? ` (${formatByteLimit(DEFAULT_MAX_BYTES)} limit)`
    : "";
  return `${text}\n\n[Showing lines ${startLine + 1}-${endLine}${byteNotice}. Use offset=${nextOffset} to continue.]`;
}

function formatByteLimit(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
