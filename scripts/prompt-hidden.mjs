import { stdin, stdout } from "node:process";

/** Asks for a secret on the terminal without echoing it (prints * per character). */
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error("No interactive terminal: set the password in an environment variable instead."));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        value += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}
