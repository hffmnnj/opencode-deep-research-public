import { Plugin, Skill } from "@opencode/plugin";
import { AGENTS, LIBRARY_HINT, agentPrompt, loadSkill, parseModelRef } from "./bundle.ts";
import { parseConfig } from "./config.ts";
import { acquireLibrary } from "./runtime.ts";
import { toJsonObject } from "./tools/format.ts";
import { TOOL_NAMESPACE, buildTools } from "./tools/tools.ts";

export default Plugin.define({
  id: "hffmnnj.deep-research",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const log = (message: string) => console.error(`[deep-research] ${message}`);
    const handle = acquireLibrary(config, log);

    // Research library tools live in Code Mode only: tools.research.<name>(…), never as direct tools.
    const tools = buildTools({ library: handle.get, windows: config.staleDays });
    await ctx.tool.transform((editor) => {
      editor.namespace(TOOL_NAMESPACE);
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as never,
          output: tool.output as never,
          options: { namespace: TOOL_NAMESPACE.name, codemode: true },
          execute: async (input) => {
            const result = await tool.execute(input);
            return { output: toJsonObject(result.output) as never, content: result.content };
          },
        });
      }
    });

    const skill = loadSkill();
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        description: skill.description,
        path: Skill.Info.fields.path.make(skill.path),
        content: skill.content,
      });
    });

    const prompts = new Map(AGENTS.map((spec) => [spec.id, agentPrompt(spec)]));
    await ctx.agent.transform((editor) => {
      for (const spec of AGENTS) {
        editor.update(spec.id, (agent) => {
          agent.name = spec.name as never;
          agent.description = spec.description;
          agent.mode = "subagent";
          if (spec.steps !== undefined) agent.steps = spec.steps;
          agent.system = prompts.get(spec.id) ?? "";
          agent.permissions = spec.permissions.map((rule) => ({ ...rule }));
          const configured = config.models[spec.modelKey];
          const model = configured ? parseModelRef(configured) : undefined;
          if (model) agent.model = model as never;
        });
        if (!editor.get(spec.id)) log(`agent ${spec.id} was not registered by this OpenCode version`);
      }
    });

    if (config.hint) {
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: LIBRARY_HINT });
      });
    }

    return () => handle.release();
  },
});
