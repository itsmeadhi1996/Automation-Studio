/* Shared by the browser and Node so model choices and reasoning modes stay aligned. */
globalThis.StudioReasonx = (() => {
  const MODEL_OPTIONS = Object.freeze(
    [
      { id: 'reasonx-v1', name: 'Automatic · task complexity (reasonx-v1)' },
      { id: 'qwen3:14b', name: 'qwen3:14b · Expert' },
      { id: 'qwen3:8b', name: 'qwen3:8b · Deep' },
      { id: 'qwen3:4b-thinking', name: 'qwen3:4b-thinking · Standard' },
      { id: 'qwen3:1.7b', name: 'qwen3:1.7b · Fast' },
    ].map(Object.freeze),
  );

  const MODE_OPTIONS = Object.freeze(
    [
      {
        id: 'auto',
        name: 'Auto',
        model: null,
        description: 'ReasonX selects Fast, Standard, Deep or Expert by task complexity.',
        timeoutMs: 740000,
      },
      { id: 'fast', name: 'Fast', model: 'qwen3:1.7b', description: 'Answer only.', timeoutMs: 130000 },
      {
        id: 'standard',
        name: 'Standard',
        model: 'qwen3:4b-thinking',
        description: 'Answer and self-review.',
        timeoutMs: 490000,
      },
      {
        id: 'deep',
        name: 'Deep',
        model: 'qwen3:8b',
        description: 'Plan, answer and self-review.',
        timeoutMs: 740000,
      },
      {
        id: 'expert',
        name: 'Expert',
        model: 'qwen3:14b',
        description: 'Plan, answer and self-review for the most complex tasks.',
        timeoutMs: 740000,
      },
    ].map(Object.freeze),
  );

  // Agent jobs report these stages. Repair attempts carry their count in `detail`.
  const AGENT_STAGES = [
    ['context', 'Gathering connected context'],
    ['analysis', 'Analyzing'],
    ['generation', 'Generating drafts'],
    ['review', 'Reviewing drafts'],
    ['repair', 'Repairing review issues'],
    ['coverage', 'Checking coverage'],
    ['completion', 'Finishing'],
  ];

  function modeHint(mode = 'auto', model = 'reasonx-v1') {
    const option = MODE_OPTIONS.find((item) => item.id === mode) || MODE_OPTIONS[0];
    if (model !== 'reasonx-v1') {
      return `${model} · ${option.description} The selected model is fixed; reasoning mode controls the workflow.`;
    }
    return option.model ? `${option.model} · ${option.description}` : option.description;
  }

  function agentStageLabel(stage, detail = '') {
    const index = AGENT_STAGES.findIndex(([id]) => id === stage);
    if (index < 0) return '';
    // Context gathering counts as the first stage alongside analysis.
    const position = Math.max(1, index);
    const suffix = detail ? ` (${detail})` : '';
    return `Agent stage ${position} of ${AGENT_STAGES.length - 1}: ${AGENT_STAGES[index][1]}${suffix}`;
  }

  return Object.freeze({
    modelOptions: MODEL_OPTIONS,
    modeOptions: MODE_OPTIONS,
    modeHint,
    agentStageLabel,
  });
})();
