import type { SourceSettingFieldsV1 } from '@helmsman/plugin-sdk';

export const jiraSettingsFields: SourceSettingFieldsV1 = Object.freeze({
  project: { label: 'Default project', schema: { type: 'string', default: '', maxLength: 128 } },
  projectByRepo: { label: 'Project mapping', schema: { type: 'string-map', default: {}, maxItems: 100, maxLength: 240 } },
  assigneeAccountId: { label: 'Claim account ID', schema: { type: 'string', default: '', maxLength: 320 } },
  assignee: { label: 'Search assignee', schema: { type: 'string', default: '', maxLength: 320 } },
  jql: { label: 'Additional JQL', schema: { type: 'string', default: '', maxLength: 8192 } },
  progressStatus: { label: 'In progress status', schema: { type: 'string', default: 'In Progress', maxLength: 240 } },
  reviewStatus: { label: 'Review status', schema: { type: 'string', default: 'In Review', maxLength: 240 } },
  readyStatuses: { label: 'Ready statuses', schema: { type: 'string-list', default: ['Backlog', 'To Do'], maxItems: 20, maxLength: 240 } },
  backlogStatus: { label: 'Backlog status', schema: { type: 'string', default: 'Backlog', maxLength: 240 } },
  todoStatus: { label: 'To do status', schema: { type: 'string', default: 'To Do', maxLength: 240 } },
  bugIssueType: { label: 'Bug issue type', schema: { type: 'string', default: 'Bug', maxLength: 128 } },
  bugSeverityField: { label: 'Bug severity field', schema: { type: 'string', default: 'customfield_14808', maxLength: 128 } },
});
