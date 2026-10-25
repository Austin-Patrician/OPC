export type NavTab = 'im' | 'org' | 'market' | 'channels' | 'deliverables' | 'skills' | 'settings';

export type AgentStatus = 'working' | 'online' | 'idle';

export interface AgentEmployee {
  id: string;
  name: string;
  role: string;
  level: string; // e.g., "P7", "P8", "M2"
  departmentId: string;
  avatarType:
    | 'founder-girl'
    | 'dark-blur'
    | 'avalonia'
    | 'dotnet'
    | 'cat'
    | 'flower'
    | 'shark'
    | 'mail'
    | 'user-silhouette'
    | 'capybara'
    | 'phone'
    | 'custom';
  avatarUrl?: string;
  avatarBg?: string;
  avatarText?: string;
  model: string;
  status: AgentStatus;
  skills: string[];
  systemPrompt: string;
  briefMd: string;
  tokenCostPerDay: string;
  completedTasks: number;
  hiredAt: string;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  leadAgentId: string;
  description: string;
  groupConversationId: string;
  color: string;
}

export interface DeliverableCardData {
  introText: string;
  title: string;
  workId: string;
  accountName: string;
  status: string;
  campaigns: string;
  link: string;
  specsTitle: string;
  specs: string[];
  pitfallsTitle: string;
  pitfalls: string[];
  footerPlaceholder?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string; // 'user' or agentEmployee.id or 'system'
  senderName: string;
  senderRole?: string;
  senderAvatarType?: AgentEmployee['avatarType'];
  senderAvatarUrl?: string;
  timestamp: string;
  showTimeHeader?: string; // e.g. "12:07" centered above message
  type: 'text' | 'deliverable-card' | 'system' | 'agent-collab';
  text?: string;
  highlightLink?: string;
  deliverable?: DeliverableCardData;
  mentions?: string[]; // agent names mentioned
  replyToText?: string;
}

export interface Conversation {
  id: string;
  title: string;
  type: 'dm' | 'group' | 'system';
  avatarType: AgentEmployee['avatarType'];
  avatarUrl?: string;
  lastMessage: string;
  lastMessagePrefixHighlight?: string; // e.g. "[@全体成员]" in red
  timestamp: string;
  unreadCount?: number;
  unreadDisplay?: string; // e.g. "99+", "65", "2", "5"
  muted?: boolean;
  departmentId?: string;
  memberAgentIds: string[];
  primaryAgentId?: string;
  messages: ChatMessage[];
}

export interface CandidateAgent {
  id: string;
  name: string;
  role: string;
  level: string;
  recommendedDeptId: string;
  avatarUrl: string;
  model: string;
  skills: string[];
  bio: string;
  systemPrompt: string;
  briefMd: string;
  tokenCostPerDay: string;
  highlightMetric: string;
}
