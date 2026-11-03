import { mapStepToRequirement } from './model.mjs';

const MAX_NAME_PART = 100;
const MIN_MATCH_SCORE = 0.6;
const MIN_SCORE_LEAD = 0.2;
const VERIFICATION_ACTIONS = ['visible', 'text', 'value'];

const DEFAULT_KINDS = {
  fill: 'text field',
  select: 'dropdown',
  check: 'checkbox',
  uncheck: 'checkbox',
  uploadFile: 'file upload field',
};

const ACTION_PATTERNS = {
  navigate: /\b(open|navigate|visit|browse|go to|launch)\b/i,
  click: /\b(click|tap|submit|choose|select|press)\b/i,
  doubleClick: /\bdouble[ -]?click\b/i,
  fill: /\b(enter|type|fill|input|provide|clear)\b/i,
  select: /\b(select|choose|pick)\b/i,
  check: /\b(check|select|tick|enable|accept)\b/i,
  uncheck: /\b(uncheck|deselect|untick|disable|clear)\b/i,
  pressKey: /\b(press|key|keyboard)\b/i,
  uploadFile: /\b(upload|attach|file)\b/i,
  visible: /\b(verify|confirm|check|ensure|visible|displayed|shown|see)\b/i,
  text: /\b(verify|confirm|check|ensure|text|message|displayed|shown)\b/i,
  value: /\b(verify|confirm|check|ensure|value|preserved)\b/i,
};

const IGNORED_WORDS = new Set(
  (
    'a an the to in on of for with and or is are be that this your its it as then user field input button ' +
    'link element text value page option checkbox radio dropdown enter type fill click select choose verify ' +
    'confirm check ensure open navigate visit go launch press clear'
  ).split(' '),
);

const clean = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

function significantWords(value) {
  const words = clean(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return new Set((words || []).filter((word) => !IGNORED_WORDS.has(word)));
}

export function readableIdentifier(value) {
  const words = clean(value)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^(btn|txt|ddl|chk|rdo|lbl|ctl)\s+/i, '')
    .trim();
  // Generated identifiers do not help readers identify a control.
  if (!words || /[\d:a-f-]{16,}/i.test(value) || /\d{5,}/.test(value) || /[:[\]#>]/.test(words)) return '';
  return words[0].toUpperCase() + words.slice(1).toLowerCase();
}

export function recordedStepName(step, description = {}) {
  const label =
    clean(description.label).slice(0, MAX_NAME_PART) ||
    readableIdentifier(description.identifier).slice(0, MAX_NAME_PART);
  const kind = description.kind || DEFAULT_KINDS[step.action] || 'element';
  const target = label ? `the “${label}” ${kind}` : `the ${kind}`;

  switch (step.action) {
    case 'navigate':
      return description.pageTitle
        ? `Open the “${clean(description.pageTitle).slice(0, MAX_NAME_PART)}” page`
        : 'Open the starting page';
    case 'click':
      return `Click ${target}`;
    case 'doubleClick':
      return `Double-click ${target}`;
    case 'fill':
      if (step.value === '') return `Clear ${target}`;
      return `Enter ${step.secret || step.sensitive ? 'the password' : 'text'} in ${target}`;
    case 'select': {
      const choices = (description.selectedLabels || [])
        .map(clean)
        .filter(Boolean)
        .join(', ')
        .slice(0, MAX_NAME_PART);
      return choices ? `Select “${choices}” from ${target}` : `Choose an option from ${target}`;
    }
    case 'check':
      return `Select ${target}`;
    case 'uncheck':
      return `Clear ${target}`;
    case 'pressKey':
      return `Press ${clean(step.value)} in ${target}`;
    case 'uploadFile':
      return `Upload a file using ${target}`;
    case 'visible':
      return `Verify that ${target} is visible`;
    case 'text':
      return `Verify the text in ${target}`;
    case 'value':
      return `Verify the value in ${target}`;
    default:
      return `Interact with ${target}`;
  }
}

function requirementMatchScore(step, requirement, subject) {
  const isVerification = VERIFICATION_ACTIONS.includes(step.action);
  const instruction = requirement.instruction;
  if (!ACTION_PATTERNS[step.action]?.test(instruction)) return 0;
  // A verification instruction must not name an action that only edits a field.
  if (!isVerification && /^(verify|confirm|ensure|assert)\b/i.test(clean(instruction))) return 0;
  if (step.action === 'click' && /\bdouble[ -]?click\b/i.test(instruction)) return 0;
  const searched = isVerification ? `${instruction} ${requirement.expectedResult || ''}` : instruction;
  const words = significantWords(searched);
  const overlap = [...subject].filter((word) => words.has(word)).length;
  return overlap / subject.size;
}

// Match both the action and its subject. Never assign requirements by step index:
// a single instruction can produce several events and incidental clicks.
export function automaticallyNameRecordedStep(step, requirements = [], description = {}) {
  if (step.qaRequirementId) return step;
  const recordedName = recordedStepName(step, description);
  const named = { ...step, name: recordedName, recordedName };
  const subject = significantWords(
    description.label || readableIdentifier(description.identifier) || description.pageTitle,
  );
  if (!subject.size) return named;

  const candidates = requirements
    .filter((requirement) => requirement.id && clean(requirement.instruction))
    .map((requirement) => ({ requirement, score: requirementMatchScore(step, requirement, subject) }))
    .sort((a, b) => b.score - a.score);
  const [best, runnerUp] = candidates;
  if (!best || best.score < MIN_MATCH_SCORE) return named;
  if (runnerUp && best.score - runnerUp.score < MIN_SCORE_LEAD) return named;
  return mapStepToRequirement(named, requirements, best.requirement.id);
}
