#!/usr/bin/env node
// Manage app accounts. Usage:
//   node manage-users.js add <email> <password>
//   node manage-users.js remove <email>
//   node manage-users.js list
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = process.env.USERS_FILE || path.join(here, "users.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function save(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 });
}

const [, , cmd, emailArg, password] = process.argv;
const email = emailArg?.trim().toLowerCase();
const users = load();

switch (cmd) {
  case "add": {
    if (!email || !password) {
      console.error("Usage: node manage-users.js add <email> <password>");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("Password must be at least 8 characters.");
      process.exit(1);
    }
    users[email] = { passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString() };
    save(users);
    console.log(`${email} saved (${Object.keys(users).length} account(s) total).`);
    break;
  }
  case "remove": {
    if (!email || !users[email]) {
      console.error(email ? `No account for ${email}.` : "Usage: node manage-users.js remove <email>");
      process.exit(1);
    }
    delete users[email];
    save(users);
    console.log(`${email} removed (${Object.keys(users).length} account(s) remaining).`);
    break;
  }
  case "list": {
    const emails = Object.keys(users);
    console.log(emails.length ? emails.join("\n") : "No accounts yet.");
    break;
  }
  default:
    console.error("Usage: node manage-users.js <add|remove|list> [email] [password]");
    process.exit(1);
}
