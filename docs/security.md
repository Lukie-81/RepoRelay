# Security overview

The authoritative public policy is [SECURITY.md](../SECURITY.md). The detailed
implementation boundary is documented in
[chatgpt-review-hardening.md](chatgpt-review-hardening.md).

The hardened profile is designed around five rules:

1. one canonical repository root is fixed at startup;
2. every request is authenticated before MCP handling;
3. repository reads reject escapes, links, multi-linked files, special files,
   and sensitive metadata;
4. mutations are limited to three fixed Markdown handoff files; and
5. shell, arbitrary process/Git execution, and generic filesystem mutation are
   absent from the registered tool surface.

The bridge does not make an arbitrary repository safe to disclose. ChatGPT can
read ordinary files inside the approved root, so users must review that tree
and its Git history before selecting it. A tunnel also introduces an external
provider and network path that must be secured independently.

Legacy privileged modes retained in the source are not part of this security
boundary and must not be exposed to untrusted clients.
