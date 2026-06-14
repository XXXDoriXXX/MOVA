
export const USER_REGISTERED_EVENT = 'user.registered';

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  registeredAt: string;
}
