import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sourcePath = path.join(root, "server.js");
const runtimePath = path.join(root, ".server-v4-runtime.mjs");
const promptsDir = path.join(root, "prompts");

let source = await fs.readFile(sourcePath, "utf8");

async function prompt(name) {
  return (await fs.readFile(path.join(promptsDir, name), "utf8")).trim();
}

function replacePromptConstant(name, value) {
  const re = new RegExp("const " + name + " = `[\\s\\S]*?`\\.trim\\(\\);");
  if (!re.test(source)) throw new Error(`Could not find ${name} in server.js`);
  source = source.replace(re, `const ${name} = ${JSON.stringify(value)};`);
}

replacePromptConstant("RULES", await prompt("refine-rules.txt"));
replacePromptConstant("EXPORT_RULES", await prompt("export-rules.txt"));
replacePromptConstant("EXPORT_CLOZE_AUDIT_RULES", await prompt("export-audit-rules.txt"));
replacePromptConstant("EXPORT_FINAL_QA_RULES", await prompt("export-final-qa-rules.txt"));

// Ground Pass 2 in BOTH the original source and Pass 1 output. This is the
// behavioral delta from the previous pipeline: the audit can improve clozes
// without drifting away from the user's original medical content.
const auditBlock = /    const auditedDraft = await callOpenAI\(\{[\s\S]*?PASS 1 OUTPUT TO AUDIT:\n\$\{draft\}`,\n    \}\);/;
if (!auditBlock.test(source)) {
  throw new Error("Could not locate the Pass 2 audit call in server.js; refusing to start with a partial v4 integration.");
}

source = source.replace(auditBlock, `    // Pass 2 receives the original source plus Pass 1 so the cloze audit stays grounded.
    const passOneFieldsForAudit = String(draft || "").split(d);
    const auditInputHasExpectedFields = passOneFieldsForAudit.length === sourceFields.length;
    const auditRecords = sourceFields.map((original, index) => [
      \`AUDIT CARD \${index + 1} ORIGINAL:\`,
      original,
      \`AUDIT CARD \${index + 1} PASS 1:\`,
      auditInputHasExpectedFields ? passOneFieldsForAudit[index] : original,
    ].join("\\n")).join("\\n\\n===AUDIT_CARD_RECORD===\\n\\n");

    const auditedDraft = await callOpenAI({
      apiKey,
      model,
      temperature: 0.1,
      input: \`\${EXPORT_CLOZE_AUDIT_RULES}

OUTPUT DELIMITER: \${d}
\${String(extraRules || "").trim() ? \`USER-SPECIFIED EXPORT INSTRUCTIONS:\\n\${String(extraRules).trim()}\\n\` : ""}
\${auditRecords}\`,
    });`);

await fs.writeFile(runtimePath, source, "utf8");

try {
  await import(`${pathToFileURL(runtimePath).href}?v=${Date.now()}`);
} finally {
  // The generated file is runtime-only; leave the repository source untouched.
  await fs.rm(runtimePath, { force: true }).catch(() => {});
}
