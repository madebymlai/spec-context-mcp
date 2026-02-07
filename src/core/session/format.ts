import { SessionFact } from './types.js';

const MAX_FACT_LINE_CHARS = 120;

function truncateObjectForLine(input: {
  subject: string;
  relation: string;
  object: string;
  sourceTaskId: string;
}): string {
  const prefix = `- ${input.subject} ${input.relation} `;
  const suffix = ` [task:${input.sourceTaskId}]`;
  const availableObjectChars = MAX_FACT_LINE_CHARS - prefix.length - suffix.length;

  if (input.object.length <= availableObjectChars) {
    return `${prefix}${input.object}${suffix}`;
  }
  if (availableObjectChars <= 0) {
    return `${prefix}${suffix}`;
  }
  if (availableObjectChars <= 3) {
    return `${prefix}${input.object.slice(0, availableObjectChars)}${suffix}`;
  }
  const clippedObject = `${input.object.slice(0, availableObjectChars - 3)}...`;
  return `${prefix}${clippedObject}${suffix}`;
}

export function formatSessionFacts(facts: SessionFact[]): string {
  if (facts.length === 0) {
    return '';
  }

  const lines = facts.map(fact => truncateObjectForLine({
    subject: fact.subject,
    relation: fact.relation,
    object: fact.object,
    sourceTaskId: fact.sourceTaskId,
  }));

  return ['[Session Context]', ...lines].join('\n');
}
