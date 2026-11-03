// Shared bounded orchestration. Provider calls and domain schemas stay in their adapters.

const DEFAULT_OPTIONS = {
  enabled: false,
  repairLimit: 1,
  guidance: '',
  model: '',
  mode: '',
};
const MAX_REPAIR_LIMIT = 3;
const MAX_GUIDANCE_LENGTH = 1000;
const MAX_MODEL_LENGTH = 120;
const REASONING_MODES = ['', 'auto', 'fast', 'standard', 'deep', 'expert'];
const MAX_REVIEW_ISSUES = 12;
const MAX_REVIEW_ISSUE_LENGTH = 300;
const CODE_FENCES = /^```(?:json)?\s*|\s*```$/g;

export function agentOptions(input = {}, previous = {}) {
  const value = { ...DEFAULT_OPTIONS, ...previous, ...input };
  const validRepairLimit =
    Number.isInteger(value.repairLimit) &&
    value.repairLimit >= 0 &&
    value.repairLimit <= MAX_REPAIR_LIMIT;
  if (typeof value.enabled !== 'boolean' || !validRepairLimit) {
    throw new Error('Agent repair limit must be an integer from 0 to 3.');
  }
  if (typeof value.guidance !== 'string' || value.guidance.length > MAX_GUIDANCE_LENGTH) {
    throw new Error('Agent workflow guidance must be at most 1000 characters.');
  }
  const validModel = typeof value.model === 'string' && value.model.length <= MAX_MODEL_LENGTH;
  if (!validModel || !REASONING_MODES.includes(value.mode)) {
    throw new Error('Choose a valid agent model and reasoning mode.');
  }
  return {
    enabled: value.enabled,
    repairLimit: value.repairLimit,
    guidance: value.guidance,
    model: value.model,
    mode: value.mode,
  };
}

export function cancelled() {
  return Object.assign(new Error('Generation cancelled. Existing drafts and test steps were preserved.'), {
    code: 'GENERATION_CANCELLED',
    status: 409,
  });
}

export function checkpoint(signal) {
  if (signal?.aborted) throw cancelled();
}

// Malformed output can be repaired by another attempt. Provider and other coded failures cannot.
function isRepairable(error) {
  if (error.kind) return false;
  return !error.code || error.code === 'AGENT_OUTPUT';
}

export function workflow({ signal, onStage = () => {}, repairLimit = 1 } = {}) {
  const stage = (name, detail = '') => {
    checkpoint(signal);
    onStage({ stage: name, detail });
  };

  const step = async (name, action) => {
    stage(name);
    const result = await action();
    checkpoint(signal);
    return result;
  };

  const generate = async ({ generate: createDraft, review }) => {
    let feedback = [];
    for (let attempt = 0; attempt <= repairLimit; attempt += 1) {
      const lastAttempt = attempt === repairLimit;
      if (attempt === 0) stage('generation');
      else stage('repair', `Repair ${attempt} of ${repairLimit}`);

      let draft;
      try {
        draft = await createDraft(feedback, attempt);
        checkpoint(signal);
      } catch (error) {
        checkpoint(signal);
        if (!isRepairable(error) || lastAttempt) throw error;
        feedback = [error.message];
        continue;
      }

      stage('review');
      try {
        feedback = await review(draft);
      } catch (error) {
        checkpoint(signal);
        if (!isRepairable(error)) throw error;
        feedback = [error.message];
      }
      checkpoint(signal);

      if (!feedback.length) return draft;
      if (lastAttempt) {
        const issues = feedback.join('; ');
        throw Object.assign(
          new Error(`Agent review needs attention: ${issues}; Repair limit reached. Existing drafts were preserved.`),
          { code: 'AGENT_REVIEW' },
        );
      }
    }
    return undefined;
  };

  return { stage, step, generate };
}

export function parseAgentJson(text) {
  let value;
  try {
    value = JSON.parse(String(text).trim().replace(CODE_FENCES, ''));
  } catch {
    value = null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('The model returned malformed structured output. Shorten the request and retry.'), {
      code: 'AGENT_OUTPUT',
    });
  }
  return value;
}

export function reviewIssues(value) {
  const valid =
    value &&
    Array.isArray(value.issues) &&
    value.issues.length <= MAX_REVIEW_ISSUES &&
    value.issues.every((issue) => typeof issue === 'string' && issue.length <= MAX_REVIEW_ISSUE_LENGTH);
  if (!valid) {
    throw Object.assign(new Error('The agent reviewer returned invalid issues.'), { code: 'AGENT_OUTPUT' });
  }
  return value.issues;
}
