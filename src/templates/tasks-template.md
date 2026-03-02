# Tasks: {spec-name}

## Format Rules

Each task MUST follow this exact format. The approval validator will reject tasks that don't comply.

### Required structure per task

    CHECKBOX {id}. {Short title}
      {Description lines}
      _Leverage: {files to use}_
      _Requirements: {requirement IDs}_
      _Prompt: Role: {role} | Task: {what to do} | Restrictions: {constraints} | Success: {done criteria}_

Where CHECKBOX is `- [ ]` (pending), `- [-]` (in-progress), or `- [x]` (completed).

### Rules

- **Checkbox**: `- [ ]` (pending), `- [-]` (in-progress), `- [x]` (completed)
- **ID**: Numeric, after checkbox. Use `1.` `2.` `3.` for sequential or `1.1` `1.2` for grouped tasks
- **_Prompt:_**: Must start with `_Prompt:` and end with `_`. Must contain `Role:`, `Task:`, `Restrictions:`, `Success:` sections separated by `|`
- **_Requirements:_**: Must reference requirement IDs from requirements.md
- **_Leverage:_**: List files/utilities the implementer should use
- One task = 1-3 files. Keep tasks atomic.

### Example

- [ ] 1. Add user validation to registration endpoint
  - Validate email format and uniqueness before insert
  - Return 409 on duplicate email
  - _Leverage: src/utils/validation.ts, src/models/User.ts_
  - _Requirements: 1.1, 1.3_
  - _Prompt: Role: Backend developer | Task: Add email format and uniqueness validation to POST /api/users endpoint, returning 409 on duplicates, using validation utilities from src/utils/validation.ts | Restrictions: Do not modify User model schema, reuse existing validation helpers | Success: Invalid emails rejected with 400, duplicate emails return 409, existing tests still pass | Instructions: Mark this ONE task [-] before starting. Follow loaded implementer guide. Mark [x] when done._

- [ ] 2. Add registration form client-side validation
  - Show inline errors for email and password fields
  - Disable submit button until form is valid
  - _Leverage: src/components/Form.tsx, src/hooks/useValidation.ts_
  - _Requirements: 2.1_
  - _Prompt: Role: Frontend developer | Task: Add client-side validation to registration form for email format and password strength using useValidation hook | Restrictions: Do not add new dependencies, follow existing form patterns | Success: Inline errors display on blur, submit disabled when invalid, no console errors | Instructions: Mark this ONE task [-] before starting. Follow loaded implementer guide. Mark [x] when done._
