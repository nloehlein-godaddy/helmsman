import type { CommunicationHealthV1, CommunicationNotificationV1, CommunicationReviewNotificationV1, CommunicationVoyageNotificationV1 } from '../plugins/communication';

export type SlackHealth = CommunicationHealthV1;
export type SlackNotification = CommunicationReviewNotificationV1;
export type VoyageNotification = CommunicationVoyageNotificationV1;
export type Notification = CommunicationNotificationV1;
export interface SlackState {
  health: SlackHealth;
  githubHealth?: SlackHealth;
  notifications: Notification[];
}
