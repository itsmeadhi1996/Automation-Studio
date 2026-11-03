import { resolveLocator } from './model.mjs';
import { readableIdentifier, recordedStepName } from './recorder-names.mjs';

const MAX_LABEL_LENGTH = 100;
const MAX_KEPT_NAME_LENGTH = 120;
const MIN_VALUE_LENGTH_IN_NAME = 3;

const PAGE_CHANGING_ACTIONS = ['click', 'doubleClick', 'pressKey'];

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlainName(value) {
  const startsWithVerb =
    /^(open|go|enter|type|click|select|choose|check|verify|wait|take|save|clear|move|hover|double[ -]click|press|upload|confirm|close|set|view|read)\s/i.test(
      value,
    );
  return startsWithVerb && !/[_{}[\]<>#]|\w+\(|\b(?:xpath|locator|css|mcp)\b/i.test(value);
}

function isGenericName(value) {
  if (!value) {
    return true;
  }
  return (
    /^(?:step\s*\d+|generated action|open|navigate|fill|click|select|check|uncheck|visible|hidden|text|value|wait|screenshot)$/i.test(
      value,
    ) || /^[a-z][\w]*_[\w]+$/i.test(value)
  );
}

function controlLabel(step, observed, object) {
  const visible = clean(observed?.label || observed?.text || step.elementName || object?.name);
  if (visible) {
    return visible.slice(0, MAX_LABEL_LENGTH);
  }
  if (['label', 'text', 'placeholder'].includes(step.locatorType)) {
    return clean(step.target).slice(0, MAX_LABEL_LENGTH);
  }
  if (['id', 'name', 'testId'].includes(step.locatorType)) {
    return readableIdentifier(step.target).slice(0, MAX_LABEL_LENGTH);
  }
  // Only extract a simple identifying attribute; never show CSS or XPath itself.
  const attribute = step.target?.match(/(?:\[\s*|@)(?:name|aria-label|placeholder|id|data-testid)\s*=\s*["']([^"']+)["']/i)?.[1];
  return attribute ? readableIdentifier(attribute).slice(0, MAX_LABEL_LENGTH) : '';
}

function controlKind(observed) {
  if (observed?.tag === 'button' || ['submit', 'button'].includes(observed?.type)) {
    return 'button';
  }
  if (observed?.tag === 'a') {
    return 'link';
  }
  if (observed?.type === 'password') {
    return 'password field';
  }
  if (observed?.tag === 'select') {
    return 'dropdown';
  }
  if (['input', 'textarea'].includes(observed?.tag)) {
    return 'field';
  }
  return /^h[1-6]$/.test(observed?.tag || '') ? 'heading' : undefined;
}

function resolveForNaming(step, object, project) {
  if (!object) {
    return step;
  }
  try {
    return resolveLocator(step, project.objects, project.locatorTemplates || []);
  } catch {
    // Naming must not prevent opening a case with a locator that needs repair.
    return step;
  }
}

function findObservedElement(inspection, resolved) {
  const framePath = JSON.stringify(resolved.framePath || []);
  return inspection.elements?.find(
    (element) =>
      element.locatorType === resolved.locatorType &&
      element.target === resolved.target &&
      JSON.stringify(element.framePath || []) === framePath,
  );
}

// Keeps descriptive model wording, but never copies input values or selectors into a title.
function canKeepExistingName(step, resolved, existing) {
  if (!isPlainName(existing) || existing.length > MAX_KEPT_NAME_LENGTH) {
    return false;
  }
  const { locatorType, target } = resolved;
  if (target && existing.includes(target)) {
    if (['css', 'xpath', 'custom'].includes(locatorType)) {
      return false;
    }
    const isCodeName =
      ['id', 'name', 'testId'].includes(locatorType) &&
      readableIdentifier(target).toLowerCase() !== target.toLowerCase();
    if (isCodeName) {
      return false;
    }
  }
  const valueInName = step.value && step.value.length >= MIN_VALUE_LENGTH_IN_NAME && existing.includes(step.value);
  return !(step.action === 'fill' && (valueInName || step.sensitive));
}

function fillName(step, label, observed, description) {
  if (/^(user\s?name|password)$/i.test(label) && step.value !== '') {
    return `Enter the ${/password/i.test(label) ? 'password' : 'username'}`;
  }
  const sensitive = step.sensitive || observed?.type === 'password';
  return recordedStepName({ ...step, sensitive }, description);
}

function fallbackName(step, label, observed, description) {
  const subject = label ? `“${label}”` : 'the page element';
  switch (step.action) {
    case 'fill':
      return fillName(step, label, observed, description);
    case 'hover':
      return `Move the pointer over ${subject}`;
    case 'hidden':
      return `Verify that ${subject} is no longer visible`;
    case 'heading':
      return 'Verify the page heading';
    case 'url':
      return 'Verify that the expected page is open';
    case 'dateOnly':
      return `Choose a date in ${label ? `the ${subject} field` : 'the date field'}`;
    case 'dateTime':
      return `Choose a date and time in ${label ? `the ${subject} field` : 'the date and time field'}`;
    case 'wait':
      return 'Wait for the page to be ready';
    case 'screenshot':
      return 'Take a screenshot of the page';
    case 'uiValidate':
      return 'Verify that the page looks as expected';
    default:
      return recordedStepName(step, description);
  }
}

export function nameGeneratedSteps(steps, { project = {}, inspection, onlyGeneric = false } = {}) {
  // Inspection data describes the first page only, so it stops applying once the page may have changed.
  let onInspectedPage = Boolean(inspection);
  return steps.map((step, index) => {
    if (index > 0 && step.action === 'navigate') {
      onInspectedPage = false;
    }
    const existing = clean(step.name);
    const leavesInspectedPage = PAGE_CHANGING_ACTIONS.includes(step.action);

    if (onlyGeneric && !isGenericName(existing)) {
      if (leavesInspectedPage) {
        onInspectedPage = false;
      }
      return step;
    }

    const object = step.locatorType === 'object' ? project.objects?.find((item) => item.id === step.target) : null;
    const resolved = resolveForNaming(step, object, project);
    const observed = onInspectedPage ? findObservedElement(inspection, resolved) : null;
    const label = controlLabel(resolved, observed, object);
    const description = {
      label,
      kind: controlKind(observed),
      pageTitle: index === 0 ? inspection?.title : undefined,
    };
    const name = canKeepExistingName(step, resolved, existing)
      ? existing
      : fallbackName(step, label, observed, description);

    if (leavesInspectedPage) {
      onInspectedPage = false;
    }
    return { ...step, name, ...(label ? { elementName: label } : {}) };
  });
}
