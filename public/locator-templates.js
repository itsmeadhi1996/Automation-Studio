/* Shared repository storage and locator resolution for the browser and Node. */
globalThis.StudioLocators = (() => {
  const PARAMETER = 'XXX';
  const LEGACY_PARAMETER = '{{value}}';
  const ANY_PARAMETER = /XXX|\{\{value\}\}/;
  const EVERY_PARAMETER = /XXX|\{\{value\}\}/g;

  const IDENTIFYING_ATTRIBUTES = new Set(['name', 'id', 'data-testid', 'aria-label', 'placeholder']);
  const CONTEXT_KEYS = ['pageUrl', 'pageIndex', 'frame', 'framePath', 'container'];
  const REPLACEMENT_CHARACTER = 0xfffd;
  const MAX_CODE_POINT = 0x10ffff;
  const SURROGATE_START = 0xd800;
  const SURROGATE_END = 0xdfff;
  const FNV_OFFSET = 2166136261;
  const FNV_PRIME = 16777619;
  const MAX_NAME_DESCRIPTION = 75;
  const NAME_WORD_COUNT = 4;

  function check(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  function hasParameter(value) {
    return ANY_PARAMETER.test(value);
  }

  function canonical(value) {
    return value.replaceAll(LEGACY_PARAMETER, PARAMETER);
  }

  function newId() {
    return crypto.randomUUID();
  }

  function caseId(test) {
    return test.qaCaseId || test.id;
  }

  function contextOf(value) {
    const present = CONTEXT_KEYS.filter((key) => value[key] !== undefined && value[key] !== '');
    return Object.fromEntries(present.map((key) => [key, structuredClone(value[key])]));
  }

  function contextFor(step, object = {}) {
    const context = { ...contextOf(object), ...contextOf(step) };
    // A step with its own single frame overrides the object's whole frame path.
    if (step.frame !== undefined && step.framePath === undefined) {
      delete context.framePath;
    }
    return context;
  }

  function cssDecode(value) {
    const withoutLineContinuations = value.replace(/\\(?:\r\n|[\n\r\f])/g, '');
    const escape = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\r\f ])?|([^\r\n\f]))/g;
    return withoutLineContinuations.replace(escape, (_, hex, char) => {
      if (!hex) {
        return char;
      }
      const point = parseInt(hex, 16);
      const invalid = !point || point > MAX_CODE_POINT || (point >= SURROGATE_START && point <= SURROGATE_END);
      return String.fromCodePoint(invalid ? REPLACEMENT_CHARACTER : point);
    });
  }

  function cssHexEscape(char) {
    return `\\${char.codePointAt(0).toString(16)} `;
  }

  function cssString(value, quote = '"') {
    return [...value]
      .map((char) => {
        if (char === '\\' || char === quote) {
          return `\\${char}`;
        }
        return /[\x00-\x1f\x7f]/.test(char) ? cssHexEscape(char) : char;
      })
      .join('');
  }

  function cssIdentifier(value) {
    return [...value]
      .map((char, index) => {
        if (char === '-' && value.length === 1) {
          return '\\-';
        }
        if (/[a-zA-Z_\u0080-￿-]/.test(char)) {
          return char;
        }
        const digitAllowed = index > 0 && !(index === 1 && value[0] === '-');
        return /\d/.test(char) && digitAllowed ? char : cssHexEscape(char);
      })
      .join('');
  }

  function xpathString(value, quote = '"') {
    if (!value.includes(quote)) {
      return `${quote}${value}${quote}`;
    }
    const other = quote === '"' ? "'" : '"';
    if (!value.includes(other)) {
      return `${other}${value}${other}`;
    }
    const parts = value.split('"').map((part) => `"${part}"`);
    return `concat(${parts.join(',\'"\',')})`;
  }

  // Returns each quoted value with its offsets. CSS backslash escapes hide quotes; XPath has none.
  function literals(selector, type) {
    const found = [];
    for (let index = 0; index < selector.length; index += 1) {
      if (type === 'css' && selector[index] === '\\') {
        index += 1;
        continue;
      }
      const quote = selector[index];
      if (quote !== '"' && quote !== "'") {
        continue;
      }
      const start = index;
      index += 1;
      while (index < selector.length && selector[index] !== quote) {
        index += type === 'css' && selector[index] === '\\' ? 2 : 1;
      }
      check(index < selector.length, 'Unclosed quoted locator value');
      const raw = selector.slice(start + 1, index);
      found.push({
        start,
        end: index + 1,
        quote,
        value: type === 'css' ? cssDecode(raw) : raw,
      });
    }
    return found;
  }

  function substituteOutsideQuotes(text, type, replacement) {
    return text.replace(EVERY_PARAMETER, () => {
      if (type === 'css') {
        return cssIdentifier(replacement);
      }
      check(
        /^(?:[A-Za-z_][\w.-]*|\d+)$/.test(replacement),
        'XPath parameters outside quotes require a name or number; put XXX inside a quoted value',
      );
      return replacement;
    });
  }

  function substitute(selector, type, replacement) {
    if (!hasParameter(selector)) {
      check(!replacement, 'Object has no replacement placeholder');
      return selector;
    }
    check(
      typeof replacement === 'string' && replacement.length > 0,
      'Unresolved locator placeholder XXX: provide a replacement value',
    );
    check(!replacement.includes('\0'), 'Locator replacement cannot contain a null character');

    let result = '';
    let cursor = 0;
    for (const literal of literals(selector, type)) {
      result += substituteOutsideQuotes(selector.slice(cursor, literal.start), type, replacement);
      if (hasParameter(literal.value)) {
        const value = literal.value.replace(EVERY_PARAMETER, () => replacement);
        result +=
          type === 'css'
            ? `${literal.quote}${cssString(value, literal.quote)}${literal.quote}`
            : xpathString(value, literal.quote);
      } else {
        result += selector.slice(literal.start, literal.end);
      }
      cursor = literal.end;
    }
    return result + substituteOutsideQuotes(selector.slice(cursor), type, replacement);
  }

  function isIdentifyingEquality(selector, literal, type) {
    const before = selector.slice(0, literal.start);
    const attribute =
      type === 'css' ? before.match(/\[\s*([\w-]+)\s*=\s*$/) : before.match(/\[@([\w-]+)\s*=\s*$/);
    return Boolean(attribute) && IDENTIFYING_ATTRIBUTES.has(attribute[1]) && /^\s*\]/.test(selector.slice(literal.end));
  }

  function maskLiterals(selector, quoted) {
    let masked = '';
    let cursor = 0;
    for (const literal of quoted) {
      masked += `${selector.slice(cursor, literal.start)}"${'v'.repeat(literal.end - literal.start - 2)}"`;
      cursor = literal.end;
    }
    return masked + selector.slice(cursor);
  }

  // Offset where the last path segment starts, or -1 when brackets do not balance.
  function terminalSegmentStart(masked, type) {
    const separator = type === 'css' ? /[\s>+~]/ : /\//;
    let terminal = 0;
    let depth = 0;
    for (let index = 0; index < masked.length; index += 1) {
      if (masked[index] === '[') {
        depth += 1;
      }
      if (masked[index] === ']') {
        depth -= 1;
      }
      if (depth < 0) {
        return -1;
      }
      if (depth === 0 && separator.test(masked[index])) {
        terminal = index + 1;
      }
    }
    return depth === 0 ? terminal : -1;
  }

  function isSimpleSelector(masked, type) {
    if (type === 'css') {
      return /^[\w\s.*#>+~\[\]="'|^-]+$/.test(masked) && !/[,():\\]/.test(masked);
    }
    // Simple location paths with equality or numeric predicates only.
    return /^(?:\/?\/?[A-Za-z_*][\w.*-]*(?:\[(?:@[\w-]+\s*=\s*"v*"|\d+)\])*)+$/.test(masked);
  }

  // Only one equality attribute on the terminal element is inferred as a parameter.
  // Parent selectors and every other condition stay byte-for-byte fixed, and complex
  // or pseudo selectors, unions and expressions are kept concrete.
  function pattern(rawSelector, type) {
    const selector = canonical(rawSelector).trim();
    let quoted;
    try {
      quoted = literals(selector, type);
    } catch {
      return null;
    }
    const masked = maskLiterals(selector, quoted);
    if (!isSimpleSelector(masked, type)) {
      return null;
    }
    const terminal = terminalSegmentStart(masked, type);
    if (terminal < 0) {
      return null;
    }
    const candidates = quoted.filter(
      (literal) => literal.start >= terminal && isIdentifyingEquality(selector, literal, type),
    );
    if (candidates.length !== 1) {
      return null;
    }
    const [candidate] = candidates;
    if (candidate.value === '') {
      return null;
    }
    // An explicit template may only vary at this supported position.
    if (hasParameter(selector.slice(0, candidate.start) + selector.slice(candidate.end))) {
      return null;
    }
    if (hasParameter(candidate.value) && candidate.value !== PARAMETER) {
      return null;
    }
    return {
      selector: `${selector.slice(0, candidate.start)}"${PARAMETER}"${selector.slice(candidate.end)}`,
      replacement: candidate.value === PARAMETER ? '' : candidate.value,
    };
  }

  function matchTemplate(selector, template, type) {
    if (!hasParameter(template) || hasParameter(selector)) {
      return null;
    }
    let concrete;
    let parameters;
    try {
      concrete = literals(selector, type);
      parameters = literals(template, type);
    } catch {
      return null;
    }
    if (concrete.length !== parameters.length) {
      return null;
    }

    let selectorCursor = 0;
    let templateCursor = 0;
    let replacement;
    for (let index = 0; index < parameters.length; index += 1) {
      const actual = concrete[index];
      const expected = parameters[index];
      if (selector.slice(selectorCursor, actual.start) !== template.slice(templateCursor, expected.start)) {
        return null;
      }
      if (hasParameter(expected.value)) {
        if (canonical(expected.value) !== PARAMETER || !actual.value) {
          return null;
        }
        if (!isIdentifyingEquality(template, expected, type)) {
          return null;
        }
        if (replacement !== undefined && replacement !== actual.value) {
          return null;
        }
        replacement = actual.value;
      } else if (actual.value !== expected.value) {
        return null;
      }
      selectorCursor = actual.end;
      templateCursor = expected.end;
    }
    if (selector.slice(selectorCursor) !== template.slice(templateCursor) || replacement === undefined) {
      return null;
    }
    return { selector: canonical(template), replacement };
  }

  function definition(object, templates = []) {
    if (object.templateId) {
      const template = templates.find((item) => item.id === object.templateId);
      check(template, 'Repository locator template not found');
      return template;
    }
    return {
      locatorType: object.locatorType || 'xpath',
      selector: object.selector || object.xpath || '',
    };
  }

  function resolve(step, objects = [], templates = []) {
    if (step.locatorType !== 'object') {
      const target = step.target || '';
      const looksLikeXpath = /^(?:xpath=|\.{0,2}\/|\()/.test(target.trim());
      const type = step.locatorType === 'custom' && looksLikeXpath ? 'xpath' : step.locatorType;
      const parameterised = ['css', 'xpath', 'custom'].includes(type) && hasParameter(target);
      return {
        ...contextOf(step),
        locatorType: type,
        target: parameterised
          ? substitute(target, type === 'xpath' ? 'xpath' : 'css', step.replacement)
          : target,
      };
    }
    const object = objects.find((item) => item.id === step.target);
    check(object, 'Repository object not found');
    const template = definition(object, templates);
    return {
      ...contextFor(step, object),
      locatorType: template.locatorType,
      target: substitute(template.selector, template.locatorType, step.replacement || object.replacement || ''),
    };
  }

  function normalizeUnquoted(text, type) {
    if (text.includes('\\')) {
      return text;
    }
    const compact = text
      .replace(/\s+/g, ' ')
      .replace(/\[\s+/g, '[')
      .replace(/\s+\]/g, ']')
      .replace(/\s*([~|^$*]?=)\s*/g, '$1');
    return type === 'css' ? compact.replace(/\s*([>+~])\s*/g, '$1') : compact;
  }

  function normalizedTemplate(rawSelector, type) {
    const selector = canonical(rawSelector).trim();
    let result = '';
    let cursor = 0;
    try {
      for (const literal of literals(selector, type)) {
        result += normalizeUnquoted(selector.slice(cursor, literal.start), type);
        result += type === 'css' ? `"${cssString(literal.value)}"` : xpathString(literal.value);
        cursor = literal.end;
      }
      return result + normalizeUnquoted(selector.slice(cursor), type);
    } catch {
      return selector;
    }
  }

  function templateKey(type, selector) {
    return JSON.stringify([type, normalizedTemplate(selector, type)]);
  }

  function ensureTemplate(project, type, selector, idFactory) {
    project.locatorTemplates ||= [];
    const key = templateKey(type, selector);
    let template = project.locatorTemplates.find(
      (item) => item.locatorType === type && templateKey(item.locatorType, item.selector) === key,
    );
    if (!template) {
      template = { id: idFactory(), locatorType: type, selector: canonical(selector) };
      project.locatorTemplates.push(template);
    }
    return template;
  }

  // The editor uses the same read-only planning as saving, so inferred values
  // can be reviewed before any repository entries are changed.
  function prepareObjectLocator(project, input) {
    const supplied = definition(input, project.locatorTemplates);
    const type = supplied.locatorType;
    const selector = normalizedTemplate(supplied.selector, type);
    check(['css', 'xpath'].includes(type), 'Repository locators must be CSS or XPath');
    check(selector.trim(), 'A locator is required');

    const objectDefinitions = (project.objects || []).flatMap((object) => {
      try {
        return [definition(object, project.locatorTemplates)];
      } catch {
        return [];
      }
    });
    const definitions = [...objectDefinitions, ...(project.locatorTemplates || [])]
      .filter((item) => item.locatorType === type)
      .map((item) => ({ ...item, selector: normalizedTemplate(item.selector, type) }));

    const exact = definitions.find((item) => canonical(item.selector) === selector);
    // Explicit supported positions are authoritative, including repeated XXX
    // positions that automatic inference would conservatively leave concrete.
    const explicit =
      !hasParameter(selector) && definitions.map((item) => matchTemplate(selector, item.selector, type)).find(Boolean);
    const inferred = explicit || pattern(exact?.selector || selector, type);
    const templateSelector = inferred?.selector || selector;
    const replacement = hasParameter(templateSelector) ? input.replacement || inferred?.replacement || '' : '';
    return { type, selector, templateSelector, replacement, inferred };
  }

  function genericName(type, rawSelector) {
    const selector = normalizedTemplate(rawSelector, type);
    if (type === 'css' && selector === '[name="XXX"]') {
      return 'genericCSSNameOnly';
    }
    if (type === 'css' && selector === '[id="XXX"]') {
      return 'genericCSSIdOnly';
    }
    const words = (selector.match(/[A-Za-z][\w-]*/g) || [])
      .filter((word) => word !== PARAMETER)
      .slice(0, NAME_WORD_COUNT);
    const pascalCase = (word) =>
      word
        .split('-')
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('');
    const description = words.map(pascalCase).join('') || 'Selector';

    let hash = FNV_OFFSET;
    for (const char of selector) {
      hash = Math.imul(hash ^ char.charCodeAt(0), FNV_PRIME);
    }
    const prefix = type === 'css' ? 'CSS' : 'XPath';
    return `generic${prefix}${description.slice(0, MAX_NAME_DESCRIPTION)}_${(hash >>> 0).toString(36)}`;
  }

  function saveObject(project, input, idFactory = newId) {
    const owner = (project.tests || []).find((test) => caseId(test) === input.testCaseId);
    check(owner, 'Select a test case before saving a repository object');
    project.objects ||= [];
    project.locatorTemplates ||= [];
    const old = project.objects.find((item) => item.id === input.id);
    check(!old || old.testCaseId === input.testCaseId, 'Cannot move an object mapping to another test case');

    const planned = prepareObjectLocator(project, input);
    const selector = normalizedTemplate(planned.templateSelector, planned.type);
    const template = ensureTemplate(project, planned.type, selector, idFactory);
    const key = templateKey(planned.type, selector);
    const duplicate = project.objects.find((item) => {
      if (item.id === input.id || item.testCaseId !== input.testCaseId) {
        return false;
      }
      const existing = definition(item, project.locatorTemplates);
      return templateKey(existing.locatorType, existing.selector) === key;
    });
    const saved = duplicate || {
      id: old?.id || input.id || idFactory(),
      testCaseId: input.testCaseId,
      name: genericName(planned.type, selector),
      locatorType: planned.type,
      templateId: template.id,
    };

    if (old) {
      project.objects = project.objects.filter((item) => item.id !== old.id);
    }
    if (!duplicate) {
      project.objects.push(saved);
    }
    if (old && duplicate) {
      for (const step of owner.steps || []) {
        if (step.locatorType === 'object' && step.target === old.id) {
          step.target = duplicate.id;
        }
      }
    }
    return saved;
  }

  function saveStepObject(project, testCaseId, step, idFactory = newId) {
    check(['css', 'xpath'].includes(step.locatorType), 'Capture a CSS or XPath locator first');
    const input = {
      testCaseId,
      locatorType: step.locatorType,
      selector: step.target,
      replacement: hasParameter(step.target) ? step.replacement : undefined,
    };
    const planned = prepareObjectLocator(project, input);
    const saved = saveObject(project, input, idFactory);
    step.elementName ||= step.name || '';
    step.replacement = planned.replacement;
    step.locatorType = 'object';
    step.target = saved.id;
    return saved;
  }

  function rememberObjectOnStep(step, object, planned) {
    const context = contextFor(step, object);
    step.replacement = step.replacement || object.replacement || planned.replacement || '';
    if (!object.testCaseId) {
      step.elementName ||= object.name || step.name || '';
    }
    for (const key of CONTEXT_KEYS) {
      delete step[key];
    }
    Object.assign(step, context);
  }

  function stepsUsingObject(steps, objectId) {
    return (steps || []).filter((step) => step.locatorType === 'object' && step.target === objectId);
  }

  // Idempotent migration that runs on load and save. Only test-step references or an
  // explicit valid owner establish ownership; orphan records are quarantined.
  function migrateRepository(project, idFactory = newId) {
    project.objects ||= [];
    project.locatorTemplates ||= [];
    const source = [...project.objects];
    const templates = project.locatorTemplates;
    const legacy = structuredClone(project.repositoryLegacyObjects || []);
    const migrated = [];
    const usedIds = new Set();
    const mappings = new Map();
    const tests = project.tests || [];
    const validOwners = new Set(tests.map(caseId));

    const quarantine = (object, reason) => {
      const serialized = JSON.stringify(object);
      if (!legacy.some((item) => JSON.stringify(item.object) === serialized)) {
        legacy.push({ object: structuredClone(object), reason });
      }
    };
    const duplicateIds = new Set(
      source
        .filter((object, index) => source.findIndex((item) => item.id === object.id) !== index)
        .map((object) => object.id),
    );

    for (const object of source) {
      if (duplicateIds.has(object.id)) {
        quarantine(object, 'Duplicate legacy object ID; its selector and ownership are ambiguous.');
        continue;
      }
      const usages = tests.flatMap((test) =>
        stepsUsingObject(test.steps, object.id).map((step) => ({ test, step })),
      );
      const prerequisiteSteps = (project.prerequisites || []).flatMap((prerequisite) =>
        stepsUsingObject(prerequisite.steps, object.id),
      );

      let planned;
      try {
        planned = prepareObjectLocator(project, object);
      } catch (error) {
        quarantine(object, error.message);
        continue;
      }

      for (const step of prerequisiteSteps) {
        rememberObjectOnStep(step, object, planned);
        step.locatorType = planned.type;
        step.target = planned.templateSelector;
      }

      const ownerIds = new Set([
        ...(validOwners.has(object.testCaseId) ? [object.testCaseId] : []),
        ...usages.map(({ test }) => caseId(test)),
      ]);
      if (!ownerIds.size) {
        quarantine(
          object,
          prerequisiteSteps.length
            ? 'Only referenced by a reusable prerequisite; its locator is retained on the prerequisite steps.'
            : 'No test-case reference establishes ownership.',
        );
        continue;
      }

      const selector = normalizedTemplate(planned.templateSelector, planned.type);
      const template = ensureTemplate(project, planned.type, selector, idFactory);
      for (const ownerId of ownerIds) {
        const key = JSON.stringify([ownerId, templateKey(planned.type, selector)]);
        let mapping = mappings.get(key);
        if (!mapping) {
          const id = usedIds.has(object.id) ? idFactory() : object.id;
          usedIds.add(id);
          mapping = {
            id,
            testCaseId: ownerId,
            name: genericName(planned.type, selector),
            locatorType: planned.type,
            templateId: template.id,
          };
          mappings.set(key, mapping);
          migrated.push(mapping);
        }
        for (const { test, step } of usages) {
          if (caseId(test) === ownerId) {
            rememberObjectOnStep(step, object, planned);
            step.target = mapping.id;
          }
        }
      }
    }

    project.objects = migrated;
    project.repositoryLegacyObjects = legacy;
    // Preserve quarantined definitions so their original records remain recoverable.
    const referenced = new Set(
      [...migrated, ...legacy.map((item) => item.object)].map((object) => object.templateId).filter(Boolean),
    );
    project.locatorTemplates = templates.filter((template) => referenced.has(template.id));
    return project;
  }

  return Object.freeze({
    hasParameter,
    pattern,
    matchTemplate,
    definition,
    resolve,
    substitute,
    prepareObjectLocator,
    saveObject,
    saveStepObject,
    migrateRepository,
    caseId,
    normalizedTemplate,
    genericName,
    contextOf,
    contextFor,
  });
})();
