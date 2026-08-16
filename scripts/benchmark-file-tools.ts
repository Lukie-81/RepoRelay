import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { openBase64ArtifactStream } from "../src/artifact-tools.js";
import { readFileTool, writeFileTool } from "../src/pi-tools.js";
import { contentLineCount, newFilePatch } from "../src/server.js";

interface TimingSummary {
  medianMs: number;
  p95Ms: number;
}

function summarize(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[
    Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)
  ] ?? 0;
  return {
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
  };
}

async function benchmark(
  operation: (iteration: number) => Promise<unknown> | unknown,
  iterations: number,
  warmups = 3,
): Promise<TimingSummary> {
  for (let index = 0; index < warmups; index++) await operation(-(index + 1));
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    await operation(index);
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
}

async function benchmarkPair(
  baselineOperation: (iteration: number) => Promise<unknown> | unknown,
  optimizedOperation: (iteration: number) => Promise<unknown> | unknown,
  iterations: number,
  warmups = 3,
): Promise<{ baseline: TimingSummary; optimized: TimingSummary }> {
  for (let index = 0; index < warmups; index++) {
    const warmupIndex = -(index + 1);
    if (index % 2 === 0) {
      await baselineOperation(warmupIndex);
      await optimizedOperation(warmupIndex);
    } else {
      await optimizedOperation(warmupIndex);
      await baselineOperation(warmupIndex);
    }
  }

  const baselineSamples: number[] = [];
  const optimizedSamples: number[] = [];
  const measure = async (
    operation: (iteration: number) => Promise<unknown> | unknown,
    samples: number[],
    iteration: number,
  ) => {
    const startedAt = performance.now();
    await operation(iteration);
    samples.push(performance.now() - startedAt);
  };

  for (let index = 0; index < iterations; index++) {
    if (index % 2 === 0) {
      await measure(baselineOperation, baselineSamples, index);
      await measure(optimizedOperation, optimizedSamples, index);
    } else {
      await measure(optimizedOperation, optimizedSamples, index);
      await measure(baselineOperation, baselineSamples, index);
    }
  }
  return {
    baseline: summarize(baselineSamples),
    optimized: summarize(optimizedSamples),
  };
}

function legacyNewFilePatch(path: string, content: string): string {
  let lines: string[];
  if (content.length === 0) {
    lines = [];
  } else if (content.endsWith("\n")) {
    lines = content.slice(0, -1).split("\n");
  } else {
    lines = content.split("\n");
  }
  const hunkRange = lines.length === 0 ? "+0,0" : `+1,${lines.length}`;
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    lines.map((line) => `+${line}`).join("\n"),
  ].filter((line) => line.length > 0).join("\n");
}

function legacyDecodeBase64(value: string): Buffer {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("invalid Base64 benchmark input");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    value.replace(/=+$/u, "")
    !== bytes.toString("base64").replace(/=+$/u, "")
  ) {
    throw new Error("invalid Base64 benchmark input");
  }
  return bytes;
}

async function consumeBase64Stream(value: string, expectedBytes: number): Promise<void> {
  const opened = openBase64ArtifactStream(value, expectedBytes);
  let total = 0;
  for await (const chunk of opened.stream) total += chunk.length;
  if (total !== expectedBytes) {
    throw new Error(`Base64 stream decoded ${total} bytes; expected ${expectedBytes}.`);
  }
}

const root = await mkdtemp(join(tmpdir(), "devspace-file-benchmark-"));
try {
  const smallText = "alpha beta gamma\n".repeat(64);
  const line = "0123456789abcdefghijklmnopqrstuvwxyz\n";
  const largeText = `UNIQUE_HEADER\n${line.repeat(299_999)}`;
  const binaryPayload = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  const binaryBase64 = binaryPayload.toString("base64");
  const smallPath = join(root, "small.txt");
  const largePath = join(root, "large.txt");
  await writeFile(smallPath, smallText);
  await writeFile(largePath, largeText);
  const context = { cwd: root, root };

  const smallRead = await benchmarkPair(
    () => {
      const tool = createReadTool(root);
      return tool.execute("benchmark", { path: smallPath, offset: 1, limit: 50 });
    },
    () => readFileTool({ path: smallPath, offset: 1, limit: 50 }, context),
    40,
    5,
  );
  const largeReadFirst100 = await benchmarkPair(
    () => {
      const tool = createReadTool(root);
      return tool.execute("benchmark", { path: largePath, offset: 1, limit: 100 });
    },
    () => readFileTool({ path: largePath, offset: 1, limit: 100 }, context),
    30,
  );
  const largeReadDeep100 = await benchmarkPair(
    () => {
      const tool = createReadTool(root);
      return tool.execute("benchmark", { path: largePath, offset: 10_000, limit: 100 });
    },
    () => readFileTool({ path: largePath, offset: 10_000, limit: 100 }, context),
    30,
  );
  const smallWrite = await benchmarkPair(
    async (index) => {
      await writeFileTool({
        path: join(root, `baseline-small-write-${index}.txt`),
        content: smallText,
      }, context);
      legacyNewFilePatch("small.txt", smallText);
    },
    async (index) => {
      await writeFileTool({
        path: join(root, `small-write-${index}.txt`),
        content: smallText,
      }, context);
      const lines = contentLineCount(smallText);
      newFilePatch("small.txt", smallText, lines);
    },
    30,
  );
  const largeWriteWithMetadata = await benchmarkPair(
    async (index) => {
      await writeFileTool({
        path: join(root, `baseline-large-write-${index}.txt`),
        content: largeText,
      }, context);
      legacyNewFilePatch("large.txt", largeText);
    },
    async (index) => {
      await writeFileTool({
        path: join(root, `large-write-${index}.txt`),
        content: largeText,
      }, context);
      const lines = contentLineCount(largeText);
      newFilePatch("large.txt", largeText, lines);
    },
    12,
    2,
  );
  const binaryDecode = await benchmarkPair(
    () => legacyDecodeBase64(binaryBase64),
    () => consumeBase64Stream(binaryBase64, binaryPayload.length),
    8,
    2,
  );

  const baseline = {
    smallRead: smallRead.baseline,
    largeReadFirst100: largeReadFirst100.baseline,
    largeReadDeep100: largeReadDeep100.baseline,
    smallWrite: smallWrite.baseline,
    largeWriteWithMetadata: largeWriteWithMetadata.baseline,
    binaryDecode: binaryDecode.baseline,
  };
  const results = {
    smallRead: smallRead.optimized,
    largeReadFirst100: largeReadFirst100.optimized,
    largeReadDeep100: largeReadDeep100.optimized,
    smallWrite: smallWrite.optimized,
    largeWriteWithMetadata: largeWriteWithMetadata.optimized,
    binaryStreamDecode: binaryDecode.optimized,
    largeMetadataOnly: await benchmark(() => {
      const lines = contentLineCount(largeText);
      newFilePatch("large.txt", largeText, lines);
    }, 30),
  };

  const acceptance = {
    firstPageAtLeastFiveTimesFaster:
      results.largeReadFirst100.medianMs <= baseline.largeReadFirst100.medianMs / 5,
    deepPageRegressionWithinTenPercent:
      results.largeReadDeep100.medianMs <= baseline.largeReadDeep100.medianMs * 1.1,
    largeWriteAtLeastThirtyPercentFaster:
      results.largeWriteWithMetadata.medianMs <= baseline.largeWriteWithMetadata.medianMs * 0.7,
    smallReadRegressionWithinTenPercent:
      results.smallRead.medianMs <= baseline.smallRead.medianMs * 1.1,
    smallWriteRegressionWithinTenPercent:
      results.smallWrite.medianMs <= baseline.smallWrite.medianMs * 1.1,
    binaryStreamRegressionWithinFiftyPercent:
      results.binaryStreamDecode.medianMs <= baseline.binaryDecode.medianMs * 1.5,
  };

  console.log(JSON.stringify({
    environment: {
      platform: platform(),
      release: release(),
      node: process.version,
      cpu: cpus()[0]?.model,
    },
    bytes: {
      small: Buffer.byteLength(smallText),
      large: Buffer.byteLength(largeText),
      binary: binaryPayload.length,
    },
    baseline,
    optimized: results,
    acceptance,
  }, null, 2));

  const failedChecks = Object.entries(acceptance)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new Error(`Benchmark acceptance failed: ${failedChecks.join(", ")}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
