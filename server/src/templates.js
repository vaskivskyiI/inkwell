// Built-in page templates (Markdown, turned into blocks by markdownToBlocks). {{date}} is replaced on use.
export const TEMPLATES = {
  meeting: {
    name: 'Meeting notes', icon: '🗓️',
    md: `**Date:** {{date}}  \n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n\n\n## Decisions\n- \n\n## Action items\n- [ ] `,
  },
  daily: {
    name: 'Daily plan', icon: '☀️',
    md: `## Top 3 today\n- [ ] \n- [ ] \n- [ ] \n\n## Schedule\n\n\n## Notes\n\n\n## Gratitude / reflection\n`,
  },
  project: {
    name: 'Project brief', icon: '🚀',
    md: `## Goal\n\n\n## Background\n\n\n## Scope\n- In: \n- Out: \n\n## Milestones\n| Milestone | Date | Owner |\n| --- | --- | --- |\n|  |  |  |\n\n## Risks\n- \n\n## Open questions\n- `,
  },
  oneOnOne: {
    name: '1:1', icon: '🤝',
    md: `**Date:** {{date}}\n\n## Their topics\n- \n\n## My topics\n- \n\n## Feedback\n\n\n## Follow-ups\n- [ ] `,
  },
  lecture: {
    name: 'Lecture notes', icon: '🎓',
    md: `**Course:**   \n**Date:** {{date}}\n\n## Key ideas\n- \n\n## Notes\n\n\n## Questions\n- \n\n## Summary\n`,
  },
};

export const WELCOME_MD = `Inkwell keeps typed and handwritten notes together, syncs them live between your devices and people you share a space with, and lets AI read both.

## Getting started
- Press **/** in a page for headings, lists, to-dos, tables, images, an ink block and AI actions.
- Select text for formatting and AI (improve, shorten, translate, explain…).
- **New journal** gives you a pen-first page — write with a stylus, AI transcribes it in the background.
- **Ctrl+K** searches everything, including your handwriting.
- **Ask Inkwell** (right panel) answers questions from your notes.

## Spaces
You start with *My space*. Make more (work, a team, a project) and share them from the space menu — co-editors see each other's cursors.

## Halcyon
Connect Halcyon in **Settings → Integrations** to link pages with e-mails, calendar events and tasks, and to start meeting notes from your calendar.

- [ ] Write your first note
- [ ] Try handwriting in a journal page`;
