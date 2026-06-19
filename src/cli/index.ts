#!/usr/bin/env node

import { Command } from "commander";
import { runCommand } from "./run.js";
import { planCommand } from "./plan.js";

const program = new Command();

program
  .name("forge")
  .description("AI-Forge local orchestration runtime")
  .version("0.1.0");

program
  .command("run")
  .argument("<intent>")
  .description("Execute an intent through the orchestration engine")
  .action(async (intent: string) => {
    await runCommand(intent);
  });

program
  .command("plan")
  .argument("<intent>")
  .description("Generate and preview execution graph")
  .action(async (intent: string) => {
    await planCommand(intent);
  });

program.parse();
