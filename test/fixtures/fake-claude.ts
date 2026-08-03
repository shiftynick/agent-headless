import { appendFileSync, readFileSync } from "node:fs";

if (process.env.FAKE_MARKER) appendFileSync(process.env.FAKE_MARKER, "started\n");

if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}

readFileSync(0, "utf8");
const sessionId = "fake-session";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model" }));
await Bun.sleep(Number(process.env.FAKE_DELAY_MS ?? 100));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "FAKE_OK",
  session_id: sessionId,
  usage: { input_tokens: 1, output_tokens: 1 },
}));
