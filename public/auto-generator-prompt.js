/* Shared by the browser and Node: turns a QA case into the Auto generator workflow prompt. */
globalThis.StudioAutoPrompt = (() => {
  const MAX_PROMPT_LENGTH = 12000;
  const hasUrl = (text) => /\bhttps?:\/\/\S+/i.test(text);

  // The linked requirement owns the page URL. QA cases only describe the page in words.
  function caseUrl(project, test) {
    const id = test.qaCaseId || test.id;
    const requirement = (project.requirements || []).find((item) => item.testIds?.includes(id));
    const url = requirement?.url || '';
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function precondition(text, url) {
    const clean = String(text || '').trim();
    if (!url || hasUrl(clean)) return clean;
    if (!clean) return `User is on ${url}.`;

    // "User is on Saucedemo login page." names the site by its host; put the address there.
    const host = new URL(url).hostname.replace(/^www\./i, '').split('.')[0];
    if (host.length > 2) {
      const named = new RegExp(`\\b${host.replace(/[^a-z0-9-]/gi, '')}\\b`, 'i');
      if (named.test(clean)) return clean.replace(named, url);
    }
    return `${clean.replace(/[.\s]+$/, '')} (${url}).`;
  }

  function verification(expected) {
    const clean = String(expected || '').trim().replace(/\s+/g, ' ');
    if (/^(verify|check|confirm|assert|ensure)\b/i.test(clean)) return clean;
    const lowered = clean.charAt(0).toLowerCase() + clean.slice(1);
    return /^(the|a|an|that)\b/i.test(clean) ? `Verify ${lowered}` : `Verify the ${lowered}`;
  }

  function build(project, test) {
    const qa = test.qa || {};
    const steps = qa.manualSteps || [];
    const lines = steps.map((step, index) => {
      const expected = step.expectedResult ? ` Expected: ${step.expectedResult}` : '';
      return `${index + 1}. ${step.instruction}${expected}`;
    });

    // The overall result becomes an explicit final check unless a step already states it.
    const overall = String(qa.expectedResult || '').trim();
    const alreadyStated = steps.some(
      (step) => String(step.expectedResult || '').trim().toLowerCase() === overall.toLowerCase(),
    );
    if (overall && !alreadyStated) lines.push(`${steps.length + 1}. ${verification(overall)}`);

    return [precondition(qa.preconditions, caseUrl(project, test)), ...lines]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_PROMPT_LENGTH);
  }

  return Object.freeze({ build, caseUrl, precondition, verification });
})();
