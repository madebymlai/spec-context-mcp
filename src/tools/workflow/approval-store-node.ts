import { ApprovalStorage } from '../../storage/approval-storage.js';
import type { ApprovalStoreFactory } from './approval-store.js';

export const nodeApprovalStoreFactory: ApprovalStoreFactory = {
  create(translatedProjectPath: string, originalProjectPath: string) {
    return new ApprovalStorage(translatedProjectPath, originalProjectPath);
  }
};
