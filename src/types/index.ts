// =============================================================================
// Core Types for LyMtrix-TEF reference implementation (CRM-ERP)
// =============================================================================

// -----------------------------------------------------------------------------
// Session & User Types
// -----------------------------------------------------------------------------

export interface Session {
  id: string;
  userId: string;
  userName: string;
  customerId?: string;
  customerName?: string;
  riskLevel: RiskLevel;
  enabledHooks?: string[];
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export type RiskLevel = 'L0' | 'L1' | 'L2';

// -----------------------------------------------------------------------------
// Operation Types
// -----------------------------------------------------------------------------

export type OperationType = 'query' | 'create' | 'update' | 'delete';

export interface Operation {
  id: string;
  type: OperationType;
  entity: string;
  action: string;
  fields?: string[];
  amount?: number;
  data?: Record<string, unknown>;
  reason?: string;
  description: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  taxId?: string;
  creditLimit: number;
  creditLine: number;
  isHighRisk: boolean;
  monthlyTransaction: number;
  lastTransactionDate?: Date;
  onboardingStatus: 'pending' | 'in_progress' | 'completed';
  onboardingData?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: string;
  customerId: string;
  customerName?: string;
  orderNo: string;
  items: OrderItem[];
  totalAmount: number;
  discount?: number;
  remark?: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'completed' | 'cancelled';

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  subtotal: number;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  method: PaymentMethod;
  remark?: string;
  status: PaymentStatus;
  createdAt: Date;
}

export type PaymentMethod = 'cash' | 'transfer' | 'credit' | 'wechat' | 'alipay';
export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';

// -----------------------------------------------------------------------------
// Tool Types
// -----------------------------------------------------------------------------

export interface ToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Agent Types
// -----------------------------------------------------------------------------

export type AgentRole = 'main' | 'sub1' | 'sub2';

export interface AgentMessage {
  messageId: string;
  timestamp: Date;
  sender: AgentRole;
  receiver: AgentRole | 'broadcast';
  type: 'proposal' | 'validation_result' | 'vote_request' | 'human_confirmation';
  payload: {
    proposalId: string;
    operationType: string;
    parameters: Record<string, unknown>;
    validationResult?: 'pass' | 'reject' | 'conditional';
    rejectReason?: string;
    riskPoints?: string[];
  };
}

export interface VotingResult {
  status: 'approved' | 'rejected' | 'diverged';
  votes: {
    mainAgent?: 'approve' | 'reject';
    subAgent1?: 'approve' | 'reject';
    subAgent2?: 'approve' | 'reject';
  };
  reason?: string;
  riskPoints?: string[];
}

// -----------------------------------------------------------------------------
// Audit Types
// -----------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  timestamp: Date;
  userId: string;
  operation: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string;
  userAgent: string;
  result: 'success' | 'failure';
  errorMessage?: string;
}

// -----------------------------------------------------------------------------
// Confirmation Types
// -----------------------------------------------------------------------------

export interface ConfirmationRequest {
  id: string;
  operation: Operation;
  riskLevel: RiskLevel;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  approverId?: string;
}
