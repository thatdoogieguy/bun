import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import path from "node:path";

const fixture = path.join(import.meta.dir, "parse-shared-buffer-fixture.ts");

// Each parser reads a byte more than once: the TypeScript lexer re-reads the
// digits of a numeric literal after it counts the separators, the markdown
// block parser scans a heading line twice, YAML asserts the byte its scanner
// read, and TOML measures a string before it converts it. A worker that writes
// the SharedArrayBuffer between the two reads aborted the process.
//
// The call counts: a debug build that parses the shared bytes in place aborts
// within 200 calls, and within 50 of `transformSync`, which costs the most.
test.concurrent.each([
  ["transpiler", 300],
  ["markdown", 1000],
  ["ansi", 1000],
  ["yaml", 1000],
  ["toml", 1000],
])("%s parses a SharedArrayBuffer a worker writes", async (api, calls) => {
  await using proc = Bun.spawn({
    cmd: [bunExe(), fixture, api, String(calls)],
    env: bunEnv,
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect({ stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ stdout: "ok", stderr: "" });
  expect(exitCode).toBe(0);
});

// `resize()` gives the trimmed pages of a resizable ArrayBuffer back. A macro
// runs in the middle of the parse, so the lexer reads the rest of the source
// after the shrink. `Bun.markdown` has the same cases next to its other buffer
// input tests, in test/js/bun/md/md-render-callback.test.ts.
test.concurrent("transformSync parses the bytes it was given when a macro shrinks the resizable input", async () => {
  using dir = tempDir("transpiler-resizable-input", {
    "macro.ts": `
      export function shrink() {
        globalThis.input.resize(0);
        return "shrunk";
      }
    `,
    "index.ts": `
      import { join } from "node:path";

      const source =
        "import { shrink } from " + JSON.stringify(join(import.meta.dir, "macro.ts")) + ' with { type: "macro" };\\n' +
        "export const a = shrink();\\n" +
        "export const b = " + JSON.stringify(Buffer.alloc(100_000, "x").toString()) + ";\\n" +
        "export const c = 'after the macro';\\n";

      const bytes = new TextEncoder().encode(source);
      globalThis.input = new ArrayBuffer(bytes.length, { maxByteLength: bytes.length });
      const view = new Uint8Array(globalThis.input);
      view.set(bytes);

      const code = new Bun.Transpiler({ loader: "ts" }).transformSync(view);
      console.log(
        JSON.stringify({
          byteLength: globalThis.input.byteLength,
          macro: code.includes('"shrunk"'),
          rest: code.includes("after the macro"),
        }),
      );
    `,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  // A debug build logs each macro call to stdout first.
  expect({ result: stdout.trim().split("\n").at(-1), stderr: stderr.trim() }).toEqual({
    result: JSON.stringify({ byteLength: 0, macro: true, rest: true }),
    stderr: "",
  });
  expect(exitCode).toBe(0);
});
