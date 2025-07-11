import { AgentError, ToolExecutionError } from './types.ts';

// Security levels and policies
export enum SecurityLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  MAXIMUM = 'maximum'
}

export interface SecurityPolicy {
  level: SecurityLevel;
  maxToolCalls: number;
  maxExecutionTime: number; // milliseconds
  maxMemoryUsage: number; // MB
  allowedCategories: string[];
  blockedCategories: string[];
  allowedDomains: string[];
  blockedDomains: string[];
  requireApproval: boolean;
  enableContentFiltering: boolean;
  enableResourceMonitoring: boolean;
  enableAuditLogging: boolean;
}

// Default security policies
export const DEFAULT_SECURITY_POLICIES: Record<SecurityLevel, SecurityPolicy> = {
  [SecurityLevel.LOW]: {
    level: SecurityLevel.LOW,
    maxToolCalls: 10,
    maxExecutionTime: 30000, // 30 seconds
    maxMemoryUsage: 100, // 100MB
    allowedCategories: ['knowledge', 'search', 'utility', 'ai', 'integration', 'execution'],
    blockedCategories: [],
    allowedDomains: [],
    blockedDomains: [],
    requireApproval: false,
    enableContentFiltering: true,
    enableResourceMonitoring: true,
    enableAuditLogging: true
  },
  [SecurityLevel.MEDIUM]: {
    level: SecurityLevel.MEDIUM,
    maxToolCalls: 5,
    maxExecutionTime: 15000, // 15 seconds
    maxMemoryUsage: 50, // 50MB
    allowedCategories: ['knowledge', 'search', 'utility', 'ai'],
    blockedCategories: ['execution'],
    allowedDomains: [],
    blockedDomains: ['localhost', '127.0.0.1', '0.0.0.0'],
    requireApproval: false,
    enableContentFiltering: true,
    enableResourceMonitoring: true,
    enableAuditLogging: true
  },
  [SecurityLevel.HIGH]: {
    level: SecurityLevel.HIGH,
    maxToolCalls: 3,
    maxExecutionTime: 10000, // 10 seconds
    maxMemoryUsage: 25, // 25MB
    allowedCategories: ['knowledge', 'search', 'utility'],
    blockedCategories: ['execution', 'integration'],
    allowedDomains: [],
    blockedDomains: ['localhost', '127.0.0.1', '0.0.0.0'],
    requireApproval: true,
    enableContentFiltering: true,
    enableResourceMonitoring: true,
    enableAuditLogging: true
  },
  [SecurityLevel.MAXIMUM]: {
    level: SecurityLevel.MAXIMUM,
    maxToolCalls: 1,
    maxExecutionTime: 5000, // 5 seconds
    maxMemoryUsage: 10, // 10MB
    allowedCategories: ['knowledge', 'utility'],
    blockedCategories: ['execution', 'integration', 'search', 'ai'],
    allowedDomains: [],
    blockedDomains: ['*'], // Block all external domains
    requireApproval: true,
    enableContentFiltering: true,
    enableResourceMonitoring: true,
    enableAuditLogging: true
  }
};

// Rate limiting
export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  maxTokens: number; // Maximum tokens per window
  keyGenerator: (userId: string) => string;
}

export interface RateLimitState {
  requests: number;
  tokens: number;
  windowStart: number;
  blocked: boolean;
  resetTime: number;
}

export class RateLimiter {
  private limits: Map<string, RateLimitState> = new Map();
  
  constructor(private config: RateLimitConfig) {}
  
  checkLimit(userId: string, tokenCount = 1): boolean {
    const key = this.config.keyGenerator(userId);
    const now = Date.now();
    const limit = this.limits.get(key) || {
      requests: 0,
      tokens: 0,
      windowStart: now,
      blocked: false,
      resetTime: now + this.config.windowMs
    };
    
    // Reset window if expired
    if (now >= limit.resetTime) {
      limit.requests = 0;
      limit.tokens = 0;
      limit.windowStart = now;
      limit.blocked = false;
      limit.resetTime = now + this.config.windowMs;
    }
    
    // Check limits
    if (limit.requests >= this.config.maxRequests || 
        limit.tokens + tokenCount > this.config.maxTokens) {
      limit.blocked = true;
      this.limits.set(key, limit);
      return false;
    }
    
    // Update counters
    limit.requests++;
    limit.tokens += tokenCount;
    this.limits.set(key, limit);
    
    return true;
  }
  
  getRemainingTime(userId: string): number {
    const key = this.config.keyGenerator(userId);
    const limit = this.limits.get(key);
    if (!limit) return 0;
    
    return Math.max(0, limit.resetTime - Date.now());
  }
  
  getUsage(userId: string): { requests: number; tokens: number; remaining: number } {
    const key = this.config.keyGenerator(userId);
    const limit = this.limits.get(key) || { requests: 0, tokens: 0, resetTime: 0 };
    
    return {
      requests: limit.requests,
      tokens: limit.tokens,
      remaining: Math.max(0, limit.resetTime - Date.now())
    };
  }
  
  clearLimit(userId: string): void {
    const key = this.config.keyGenerator(userId);
    this.limits.delete(key);
  }
}

// Content filtering
export interface ContentFilter {
  name: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high';
  category: string;
  replacement?: string;
}

export const DEFAULT_CONTENT_FILTERS: ContentFilter[] = [
  // Sensitive information
  {
    name: 'credit_card',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    severity: 'high',
    category: 'pii',
    replacement: '[REDACTED_CREDIT_CARD]'
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: 'high',
    category: 'pii',
    replacement: '[REDACTED_SSN]'
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    severity: 'medium',
    category: 'pii',
    replacement: '[REDACTED_EMAIL]'
  },
  {
    name: 'phone',
    pattern: /\b\d{3}-\d{3}-\d{4}\b|\b\(\d{3}\)\s?\d{3}-\d{4}\b/g,
    severity: 'medium',
    category: 'pii',
    replacement: '[REDACTED_PHONE]'
  },
  
  // Malicious content
  {
    name: 'sql_injection',
    pattern: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b.*\b(FROM|INTO|SET|WHERE|TABLE)\b)|(\b(UNION|OR|AND)\b.*\b(SELECT|INSERT|UPDATE|DELETE)\b)/gi,
    severity: 'high',
    category: 'malicious'
  },
  {
    name: 'xss',
    pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    severity: 'high',
    category: 'malicious'
  },
  {
    name: 'command_injection',
    pattern: /(\b(rm|del|format|fdisk|mkfs)\b.*[-\/])|(\b(curl|wget|nc|netcat)\b.*\b(http|ftp|tcp)\b)/gi,
    severity: 'high',
    category: 'malicious'
  },
  
  // Inappropriate content
  {
    name: 'profanity',
    pattern: /\b(shit|fuck|damn|hell|crap|ass|bitch|bastard)\b/gi,
    severity: 'low',
    category: 'inappropriate',
    replacement: '[FILTERED]'
  }
];

export class ContentFilterManager {
  private filters: ContentFilter[] = [];
  
  constructor(filters: ContentFilter[] = DEFAULT_CONTENT_FILTERS) {
    this.filters = filters;
  }
  
  addFilter(filter: ContentFilter): void {
    this.filters.push(filter);
  }
  
  removeFilter(name: string): void {
    this.filters = this.filters.filter(f => f.name !== name);
  }
  
  scanContent(content: string): {
    violations: Array<{
      filter: string;
      severity: string;
      category: string;
      matches: string[];
    }>;
    filtered: string;
    blocked: boolean;
  } {
    const violations: Array<{
      filter: string;
      severity: string;
      category: string;
      matches: string[];
    }> = [];
    
    let filtered = content;
    let blocked = false;
    
    for (const filter of this.filters) {
      const matches = content.match(filter.pattern);
      if (matches) {
        violations.push({
          filter: filter.name,
          severity: filter.severity,
          category: filter.category,
          matches: [...new Set(matches)] // Remove duplicates
        });
        
        // Replace matches if replacement is provided
        if (filter.replacement) {
          filtered = filtered.replace(filter.pattern, filter.replacement);
        }
        
        // Block if high severity
        if (filter.severity === 'high') {
          blocked = true;
        }
      }
    }
    
    return { violations, filtered, blocked };
  }
  
  getFilters(): ContentFilter[] {
    return [...this.filters];
  }
}

// Resource monitoring
export interface ResourceUsage {
  memory: number; // MB
  cpu: number; // percentage
  executionTime: number; // milliseconds
  networkRequests: number;
  diskUsage: number; // MB
}

export interface ResourceLimits {
  maxMemory: number; // MB
  maxCpu: number; // percentage
  maxExecutionTime: number; // milliseconds
  maxNetworkRequests: number;
  maxDiskUsage: number; // MB
}

export class ResourceMonitor {
  private usage: Map<string, ResourceUsage> = new Map();
  private limits: ResourceLimits;
  
  constructor(limits: ResourceLimits) {
    this.limits = limits;
  }
  
  startMonitoring(sessionId: string): void {
    this.usage.set(sessionId, {
      memory: 0,
      cpu: 0,
      executionTime: 0,
      networkRequests: 0,
      diskUsage: 0
    });
  }
  
  updateUsage(sessionId: string, updates: Partial<ResourceUsage>): void {
    const current = this.usage.get(sessionId);
    if (!current) return;
    
    this.usage.set(sessionId, { ...current, ...updates });
  }
  
  checkLimits(sessionId: string): {
    withinLimits: boolean;
    violations: string[];
    usage: ResourceUsage;
  } {
    const usage = this.usage.get(sessionId);
    if (!usage) {
      return { withinLimits: true, violations: [], usage: this.getDefaultUsage() };
    }
    
    const violations: string[] = [];
    
    if (usage.memory > this.limits.maxMemory) {
      violations.push(`Memory usage (${usage.memory}MB) exceeds limit (${this.limits.maxMemory}MB)`);
    }
    
    if (usage.cpu > this.limits.maxCpu) {
      violations.push(`CPU usage (${usage.cpu}%) exceeds limit (${this.limits.maxCpu}%)`);
    }
    
    if (usage.executionTime > this.limits.maxExecutionTime) {
      violations.push(`Execution time (${usage.executionTime}ms) exceeds limit (${this.limits.maxExecutionTime}ms)`);
    }
    
    if (usage.networkRequests > this.limits.maxNetworkRequests) {
      violations.push(`Network requests (${usage.networkRequests}) exceed limit (${this.limits.maxNetworkRequests})`);
    }
    
    if (usage.diskUsage > this.limits.maxDiskUsage) {
      violations.push(`Disk usage (${usage.diskUsage}MB) exceeds limit (${this.limits.maxDiskUsage}MB)`);
    }
    
    return {
      withinLimits: violations.length === 0,
      violations,
      usage
    };
  }
  
  getUsage(sessionId: string): ResourceUsage {
    return this.usage.get(sessionId) || this.getDefaultUsage();
  }
  
  stopMonitoring(sessionId: string): void {
    this.usage.delete(sessionId);
  }
  
  private getDefaultUsage(): ResourceUsage {
    return {
      memory: 0,
      cpu: 0,
      executionTime: 0,
      networkRequests: 0,
      diskUsage: 0
    };
  }
}

// Security audit logging
export interface SecurityEvent {
  id: string;
  timestamp: Date;
  type: 'rate_limit' | 'content_filter' | 'resource_limit' | 'policy_violation' | 'access_denied' | 'suspicious_activity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  userId: string;
  sessionId?: string;
  details: Record<string, any>;
  message: string;
}

export class SecurityAuditLogger {
  private events: SecurityEvent[] = [];
  private maxEvents = 10000;
  
  log(event: Omit<SecurityEvent, 'id' | 'timestamp'>): void {
    const securityEvent: SecurityEvent = {
      id: this.generateId(),
      timestamp: new Date(),
      ...event
    };
    
    this.events.push(securityEvent);
    
    // Trim old events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    
    // In production, you'd send this to a logging service
    if (event.severity === 'high' || event.severity === 'critical') {
      console.warn('Security Event:', securityEvent);
    }
  }
  
  getEvents(filter?: {
    userId?: string;
    type?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
  }): SecurityEvent[] {
    let filtered = this.events;
    
    if (filter) {
      if (filter.userId) {
        filtered = filtered.filter(e => e.userId === filter.userId);
      }
      if (filter.type) {
        filtered = filtered.filter(e => e.type === filter.type);
      }
      if (filter.severity) {
        filtered = filtered.filter(e => e.severity === filter.severity);
      }
      if (filter.startDate) {
        filtered = filtered.filter(e => e.timestamp >= filter.startDate!);
      }
      if (filter.endDate) {
        filtered = filtered.filter(e => e.timestamp <= filter.endDate!);
      }
    }
    
    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
  
  clearEvents(): void {
    this.events = [];
  }
  
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

// Main security manager
export class SecurityManager {
  private rateLimiter: RateLimiter;
  private contentFilter: ContentFilterManager;
  private resourceMonitor: ResourceMonitor;
  private auditLogger: SecurityAuditLogger;
  private policies: Map<string, SecurityPolicy> = new Map();
  
  constructor(
    rateLimitConfig?: RateLimitConfig,
    contentFilters?: ContentFilter[],
    resourceLimits?: ResourceLimits
  ) {
    this.rateLimiter = new RateLimiter(rateLimitConfig || {
      windowMs: 60000, // 1 minute
      maxRequests: 100,
      maxTokens: 10000,
      keyGenerator: (userId: string) => `user:${userId}`
    });
    
    this.contentFilter = new ContentFilterManager(contentFilters);
    
    this.resourceMonitor = new ResourceMonitor(resourceLimits || {
      maxMemory: 100,
      maxCpu: 80,
      maxExecutionTime: 30000,
      maxNetworkRequests: 10,
      maxDiskUsage: 50
    });
    
    this.auditLogger = new SecurityAuditLogger();
    
    // Load default policies
    for (const [level, policy] of Object.entries(DEFAULT_SECURITY_POLICIES)) {
      this.policies.set(level, policy);
    }
  }
  
  // Policy management
  setPolicy(userId: string, policy: SecurityPolicy): void {
    this.policies.set(userId, policy);
  }
  
  getPolicy(userId: string): SecurityPolicy {
    return this.policies.get(userId) || DEFAULT_SECURITY_POLICIES[SecurityLevel.MEDIUM];
  }
  
  // Pre-execution security check
  async checkPreExecution(
    userId: string,
    toolId: string,
    parameters: Record<string, any>,
    sessionId?: string
  ): Promise<{
    allowed: boolean;
    violations: string[];
    filteredParameters: Record<string, any>;
  }> {
    const policy = this.getPolicy(userId);
    const violations: string[] = [];
    let filteredParameters = { ...parameters };
    
    // Check rate limits
    const parameterString = JSON.stringify(parameters);
    const tokenCount = Math.ceil(parameterString.length / 4); // Rough token estimate
    
    if (policy.enableAuditLogging && !this.rateLimiter.checkLimit(userId, tokenCount)) {
      violations.push('Rate limit exceeded');
      this.auditLogger.log({
        type: 'rate_limit',
        severity: 'medium',
        userId,
        sessionId,
        message: 'Rate limit exceeded',
        details: { toolId, tokenCount, usage: this.rateLimiter.getUsage(userId) }
      });
    }
    
    // Check content filtering
    if (policy.enableContentFiltering) {
      const contentResult = this.contentFilter.scanContent(parameterString);
      if (contentResult.blocked) {
        violations.push('Content blocked by filter');
        this.auditLogger.log({
          type: 'content_filter',
          severity: 'high',
          userId,
          sessionId,
          message: 'Content blocked by security filter',
          details: { toolId, violations: contentResult.violations }
        });
      } else if (contentResult.violations.length > 0) {
        // Apply content filtering to parameters
        try {
          filteredParameters = JSON.parse(contentResult.filtered);
        } catch {
          // If parsing fails, use original parameters but log the issue
          this.auditLogger.log({
            type: 'content_filter',
            severity: 'low',
            userId,
            sessionId,
            message: 'Content filter applied but JSON parsing failed',
            details: { toolId, violations: contentResult.violations }
          });
        }
      }
    }
    
    // Check resource limits
    if (policy.enableResourceMonitoring && sessionId) {
      const resourceCheck = this.resourceMonitor.checkLimits(sessionId);
      if (!resourceCheck.withinLimits) {
        violations.push(...resourceCheck.violations);
        this.auditLogger.log({
          type: 'resource_limit',
          severity: 'high',
          userId,
          sessionId,
          message: 'Resource limits exceeded',
          details: { toolId, violations: resourceCheck.violations, usage: resourceCheck.usage }
        });
      }
    }
    
    return {
      allowed: violations.length === 0,
      violations,
      filteredParameters
    };
  }
  
  // Post-execution security check
  async checkPostExecution(
    userId: string,
    toolId: string,
    result: any,
    sessionId?: string,
    executionTime?: number
  ): Promise<{
    allowed: boolean;
    violations: string[];
    filteredResult: any;
  }> {
    const policy = this.getPolicy(userId);
    const violations: string[] = [];
    let filteredResult = result;
    
    // Update resource usage
    if (policy.enableResourceMonitoring && sessionId && executionTime) {
      this.resourceMonitor.updateUsage(sessionId, {
        executionTime: executionTime,
        networkRequests: 1 // Increment network request count
      });
    }
    
    // Check result content
    if (policy.enableContentFiltering && typeof result === 'string') {
      const contentResult = this.contentFilter.scanContent(result);
      if (contentResult.blocked) {
        violations.push('Result blocked by content filter');
        this.auditLogger.log({
          type: 'content_filter',
          severity: 'high',
          userId,
          sessionId,
          message: 'Tool result blocked by content filter',
          details: { toolId, violations: contentResult.violations }
        });
      } else if (contentResult.violations.length > 0) {
        filteredResult = contentResult.filtered;
      }
    }
    
    return {
      allowed: violations.length === 0,
      violations,
      filteredResult
    };
  }
  
  // Session management
  startSession(userId: string, sessionId: string): void {
    const policy = this.getPolicy(userId);
    if (policy.enableResourceMonitoring) {
      this.resourceMonitor.startMonitoring(sessionId);
    }
    
    if (policy.enableAuditLogging) {
      this.auditLogger.log({
        type: 'access_denied',
        severity: 'low',
        userId,
        sessionId,
        message: 'Security session started',
        details: { policy: policy.level }
      });
    }
  }
  
  endSession(userId: string, sessionId: string): void {
    const policy = this.getPolicy(userId);
    if (policy.enableResourceMonitoring) {
      this.resourceMonitor.stopMonitoring(sessionId);
    }
    
    if (policy.enableAuditLogging) {
      this.auditLogger.log({
        type: 'access_denied',
        severity: 'low',
        userId,
        sessionId,
        message: 'Security session ended',
        details: {}
      });
    }
  }
  
  // Utility methods
  getRateLimitStatus(userId: string): { requests: number; tokens: number; remaining: number } {
    return this.rateLimiter.getUsage(userId);
  }
  
  getResourceUsage(sessionId: string): ResourceUsage {
    return this.resourceMonitor.getUsage(sessionId);
  }
  
  getSecurityEvents(filter?: {
    userId?: string;
    type?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
  }): SecurityEvent[] {
    return this.auditLogger.getEvents(filter);
  }
  
  addContentFilter(filter: ContentFilter): void {
    this.contentFilter.addFilter(filter);
  }
  
  removeContentFilter(name: string): void {
    this.contentFilter.removeFilter(name);
  }
  
  getContentFilters(): ContentFilter[] {
    return this.contentFilter.getFilters();
  }
  
  clearSecurityEvents(): void {
    this.auditLogger.clearEvents();
  }
}

// Security middleware for integration with other systems
export class SecurityMiddleware {
  constructor(private securityManager: SecurityManager) {}
  
  async validateRequest(
    userId: string,
    toolId: string,
    parameters: Record<string, any>,
    sessionId?: string
  ): Promise<{
    allowed: boolean;
    violations: string[];
    filteredParameters: Record<string, any>;
  }> {
    return this.securityManager.checkPreExecution(userId, toolId, parameters, sessionId);
  }
  
  async validateResponse(
    userId: string,
    toolId: string,
    result: any,
    sessionId?: string,
    executionTime?: number
  ): Promise<{
    allowed: boolean;
    violations: string[];
    filteredResult: any;
  }> {
    return this.securityManager.checkPostExecution(userId, toolId, result, sessionId, executionTime);
  }
}

// Export utility functions
export const SecurityUtils = {
  generateSecureId: (): string => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },
  
  hashSensitiveData: (data: string): string => {
    // Simple hash for demo - in production use proper crypto
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  },
  
  sanitizeUrl: (url: string): string => {
    try {
      const parsed = new URL(url);
      // Remove sensitive query parameters
      const sensitiveParams = ['password', 'token', 'api_key', 'secret'];
      for (const param of sensitiveParams) {
        parsed.searchParams.delete(param);
      }
      return parsed.toString();
    } catch {
      return '[INVALID_URL]';
    }
  }
}; 