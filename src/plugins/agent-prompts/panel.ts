import { createAgentPromptEditorV1, type AgentPromptEditorStateV1, type PluginPanelModule, type PluginPanelState } from '@helmsman/plugin-sdk';

const editorState = (state: PluginPanelState): AgentPromptEditorStateV1 => ({ active: state.visible && state.activity.active, pirateMode: state.pirateMode, signal: state.activity.signal });
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.agentPrompts?.version !== 1) throw new Error('Agent prompts require version 1 public settings services.');
  const editor = createAgentPromptEditorV1(container, { service: context.services.agentPrompts, signal: context.signal,
    contributionId: context.contributionId ?? '', instanceId: context.state.instanceId, state: editorState(context.state) });
  context.onDispose(editor.dispose);
  return { update(state) { editor.update(editorState(state)); }, refresh: editor.refresh, dispose: editor.dispose };
} };
export default panel;
