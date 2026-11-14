import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFile } from "./skills.js";
import type { Skill } from "./skills.js";

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  filePath: string;
  source?: "skill";
}

/**
 * Load custom slash commands from {cwd}/.gg/commands/*.md
 * Each .md file becomes a slash command. Frontmatter provides name/description,
 * and the body becomes the prompt injected into the agent.
 */
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const commandsDir = path.join(cwd, ".gg", "commands");
  const commands: CustomCommand[] = [];

  let files: string[];
  try {
    files = await fs.readdir(commandsDir);
  } catch {
    return commands;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, file);

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = parseSkillFile(raw, "project");
      const name = parsed.name || path.basename(file, ".md");
      commands.push({
        name,
        description: parsed.description || `Custom command from .gg/commands/${file}`,
        prompt: parsed.content,
        filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return commands;
}

/**
 * Custom commands from every workspace root: the project first, then each
 * folder added to it (`/add-dir`, a goal's attached repos). A name already
 * taken by an earlier root is skipped, so the project's own command wins.
 */
export async function loadWorkspaceCustomCommands(
  roots: readonly string[],
): Promise<CustomCommand[]> {
  const perRoot = await Promise.all(roots.map((root) => loadCustomCommands(root)));
  const seen = new Set<string>();
  const commands: CustomCommand[] = [];
  for (const command of perRoot.flat()) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(command);
  }
  return commands;
}

/** One slash command per visible skill; names already in `taken` win. */
export function skillCommands(
  skills: readonly Skill[],
  taken: readonly CustomCommand[],
): CustomCommand[] {
  const seen = new Set(taken.map((c) => c.name));
  const commands: CustomCommand[] = [];
  for (const skill of skills) {
    if (skill.hidden || seen.has(skill.name)) continue;
    seen.add(skill.name);
    commands.push({
      name: skill.name,
      description: skill.description || "Skill",
      // Invocation args are appended by expandPromptCommand, so no $ARGUMENTS here.
      prompt: `Before doing anything else, load the skill named exactly "${skill.name}" with the skill tool, then follow it for the user's request below (if any).`,
      filePath: skill.root ?? "",
      source: "skill",
    });
  }
  return commands;
}
