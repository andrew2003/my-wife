// Shared helpers for the factory hooks.
// Hooks receive one JSON object on stdin and signal a block with exit code 2 and a message on stderr.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function readInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Repository-relative POSIX path of a file path from a tool call. */
export function relPath(filePath) {
  if (!filePath) return '';
  const abs = path.isAbsolute(filePath) ? filePath : path.join(projectDir(), filePath);
  return path.relative(projectDir(), abs).split(path.sep).join('/');
}

/** All text a tool call would write: file content for Write, new_string for Edit, edits for MultiEdit. */
export function newTexts(toolInput) {
  const out = [];
  if (typeof toolInput.content === 'string') out.push(toolInput.content);
  if (typeof toolInput.new_string === 'string') out.push(toolInput.new_string);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) if (typeof e.new_string === 'string') out.push(e.new_string);
  }
  return out;
}

export function readIfExists(file) {
  try {
    const abs = path.isAbsolute(file) ? file : path.join(projectDir(), file);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  } catch {
    return '';
  }
}

export function block(message) {
  process.stderr.write(`BLOCKED by factory hook: ${message}\n`);
  process.exit(2);
}

export const isTestFile = (rel) =>
  /(^|\/)(__tests__|tests?|e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

export const isEnvFile = (rel) => {
  const base = rel.split('/').pop() ?? '';
  if (base === '.env.example') return false;
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
};
