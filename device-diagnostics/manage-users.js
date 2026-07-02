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
  case "plan": {
    const plan = password; // third arg doubles as the plan name
    if (!email || !users[email] || !["free", "pro"].includes(plan)) {
      console.error("Usage: node manage-users.js plan <email> <free|pro>");
      process.exit(1);
    }
    users[email].plan = plan;
    save(users);
    console.log(`${email} set to the ${plan} plan.`);
    break;
  }
  case "credits": {
    const credits = parseInt(password, 10); // third arg doubles as the credit count
    if (!email || !users[email] || !Number.isInteger(credits) || credits < 0) {
      console.error("Usage: node manage-users.js credits <email> <count>");
      process.exit(1);
    }
    users[email].credits = credits;
    save(users);
    console.log(`${email} now has ${credits} credits.`);
    break;
  }
  case "quota": {
    const quota = parseInt(password, 10); // third arg doubles as the quota number
    if (!email || !users[email] || !Number.isInteger(quota) || quota < 0) {
      console.error("Usage: node manage-users.js quota <email> <analyses-per-month>");
      process.exit(1);
    }
    users[email].quota = quota;
    save(users);
    console.log(`${email} quota set to ${quota} analyses/month.`);
    break;
  }
  case "list": {
    const emails = Object.keys(users);
    console.log(
      emails.length
        ? emails.map((e) => `${e} [${users[e].plan === "pro" ? "pro" : "free"}]${Number.isInteger(users[e].quota) ? ` (quota: ${users[e].quota})` : ""}${users[e].credits > 0 ? ` (${users[e].credits} credits)` : ""}${users[e].apiKeyEnc ? " [own API key]" : ""}`).join("\n")
        : "No accounts yet."
    );
    break;
  }
  default:
    console.error("Usage: node manage-users.js <add|remove|plan|quota|credits|list> [email] [password|plan|quota|credits]");
    process.exit(1);
}
