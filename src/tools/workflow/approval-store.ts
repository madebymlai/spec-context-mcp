export type ApprovalType = 'document' | 'action';
export type ApprovalCategory = 'spec' | 'steering';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'needs-revision';

export interface ApprovalComment {
  type: 'selection' | 'general';
  selectedText?: string;
  comment: string;
}

export interface ApprovalRecord {
  id: string;
  title: string;
  filePath: string;
  type: ApprovalType;
  status: ApprovalStatus;
  createdAt: string;
  respondedAt?: string;
  response?: string;
  annotations?: string;
  comments?: ApprovalComment[];
  category: ApprovalCategory;
  categoryName: string;
}

export interface ApprovalStore {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAllPendingApprovals(): Promise<ApprovalRecord[]>;
  createApproval(
    title: string,
    filePath: string,
    category: ApprovalCategory,
    categoryName: string,
    type: ApprovalType
  ): Promise<string>;
  getApproval(approvalId: string): Promise<ApprovalRecord | null>;
  deleteApproval(approvalId: string): Promise<boolean>;
}

export interface ApprovalStoreFactory {
  create(translatedProjectPath: string, originalProjectPath: string): ApprovalStore;
}
