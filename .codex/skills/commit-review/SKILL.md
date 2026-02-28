---
name: commit-review
description: Review the latest git commit for principles.md compliance, bugs, and inconsistencies. Use when user says "/isitok", "review commit", "check commit", "is it ok", or wants to validate recent changes against architecture principles.
---

# Commit Review

Review the latest commit against principles.md KEY PRINCIPLES and check for bugs/inconsistencies.

## Workflow

### Step 1: Gather Commit Context

```bash
# Get the latest commit details
git show --stat HEAD
git show HEAD --no-stat
```

### Step 2: Read principles.md

Read `.spec-context/steering/principles.md` to load the KEY PRINCIPLES checklist.

### Step 3: Analyze Each Changed File

For each file in the commit:
1. Read the full file (not just the diff) to understand context
2. Check the changes against each principle

### Step 4: Output Review

Output must be **strict JSON only**.

- Return exactly one JSON object.
- Do not output Markdown, bullets, prose outside JSON, or code fences.
- Use only the keys and enum values defined below.
- If there are no bugs/inconsistencies, use empty arrays (`[]`), not strings.

Required JSON shape example:

```json
{
  "commit_review": {
    "commit": {
      "short_hash": "<short-hash>",
      "summary": "<one-line description>"
    },
    "principles_compliance": [
      { "principle": "SRP", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "OCP", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "LSP", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "ISP", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "DIP", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "No Defensive Garbage", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "KISS", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "Domain is Pure", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "DRY", "status": "ok|warning|violation", "notes": "<brief note>" },
      { "principle": "Composition > Inheritance", "status": "ok|warning|violation", "notes": "<brief note>" }
    ],
    "bugs_and_issues": [
      {
        "severity": "high|medium|low",
        "file": "<path>",
        "line": 1,
        "issue": "<what is wrong>",
        "impact": "<why it matters>",
        "recommendation": "<what to change>"
      }
    ],
    "inconsistencies": [
      {
        "severity": "high|medium|low",
        "file": "<path>",
        "line": 1,
        "issue": "<what is inconsistent>",
        "recommendation": "<what to align>"
      }
    ],
    "verdict": {
      "status": "PASS|PASS_WITH_NOTES|NEEDS_REVISION",
      "summary": "<brief summary>"
    }
  }
}
```

## Review Guidelines

- **Be specific**: Reference file:line for issues
- **Be practical**: Minor style issues are `warning`, not `violation`
- **Skip N/A**: If a principle doesn't apply, use status `ok` with notes `"N/A"`
- **Focus on the diff**: Only review what changed, not pre-existing issues
