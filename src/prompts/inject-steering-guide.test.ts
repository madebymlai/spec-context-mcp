import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { injectSteeringGuidePrompt } from './inject-steering-guide.js';
import { TestFileContentCache } from '../tools/workflow/test-file-content-cache.js';

describe('inject-steering-guide prompt', () => {
  const createContext = () => ({
    projectPath: join(tmpdir(), 'test'),
    dashboardUrl: 'http://localhost:3000',
    fileContentCache: new TestFileContentCache(),
  });

  it('injects steering templates into prompt context', async () => {
    const messages = await injectSteeringGuidePrompt.handler({}, createContext());

    expect(messages).toHaveLength(1);
    const text = messages[0]?.content?.type === 'text' ? messages[0].content.text : '';

    expect(text).toContain('**Injected Steering Templates (use these directly; do not re-read template files from disk):**');
    expect(text).toContain('### product-template.md');
    expect(text).toContain('### tech-template.md');
    expect(text).toContain('### structure-template.md');
    expect(text).toContain('### principles-template.md');
    expect(text).toContain('```markdown');
  });
});
