// Manage who can log in to the editor page. Passwords are stored as salted scrypt hashes.
//   npm run editor -- add <username>       (create, or reset the password if it exists)
//   npm run editor -- add <username> --allow-weak   (sample users only: accepts 6+ characters instead of 12+)
//   npm run editor -- remove <username>
//   npm run editor -- list
// Changing a password signs that person out everywhere. Uses the same .env as the API.
const path = require("path");
try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {}
const readline = require("readline");
const { setEditorPassword, removeEditor, listEditors } = require("../src/auth");
const { close } = require("../src/db");

// One reader for all prompts (a new reader per prompt can lose buffered input). Never echoes what is typed.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let muted = false;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (str) => (muted ? undefined : write(str));
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift().resolve(l) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    waiting.splice(0).forEach((w) => w.reject(new Error("No input received")));
  });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      muted = true;
      const done = (v) => {
        muted = false;
        process.stdout.write("\n");
        return v;
      };
      if (lines.length) return Promise.resolve(done(lines.shift()));
      if (closed) return Promise.reject(new Error("No input received"));
      return new Promise((resolve, reject) => waiting.push({ resolve, reject })).then(done, (e) => { muted = false; throw e; });
    },
    close: () => rl.close(),
  };
}

(async () => {
  const [cmd, username, ...flags] = process.argv.slice(2);
  const allowWeak = flags.includes("--allow-weak");
  if (cmd === "add" && username) {
    const prompter = makePrompter();
    let pw;
    try {
      pw = await prompter.ask("Password (12+ characters): ");
      if (pw !== (await prompter.ask("Repeat password: "))) throw new Error("Passwords do not match");
    } finally {
      prompter.close();
    }
    const r = await setEditorPassword(username, pw, { allowWeak });
    console.log(r.created ? `Created editor "${r.username}".` : `Updated password for "${r.username}" (signed out everywhere).`);
  } else if (cmd === "remove" && username) {
    console.log((await removeEditor(username)) ? `Removed "${username}" (their sessions stop working immediately).` : `No editor named "${username}".`);
  } else if (cmd === "list") {
    const all = await listEditors();
    console.log(all.length ? all.map((e) => `${e.username}  (password set ${e.passwordChangedAt.toISOString().slice(0, 10)})`).join("\n") : "No editors yet. Run: npm run editor -- add <username>");
  } else {
    console.log("Usage: npm run editor -- add <username> [--allow-weak] | remove <username> | list");
    process.exitCode = 1;
  }
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
