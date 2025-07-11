import { 
  ToolDefinition, 
  ToolExecutionResult, 
  ToolRegistry, 
  ExecutionEnvironment,
  ValidationResult,
  AgentError,
  ToolExecutionError
} from './types.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';

// Message types for conversation 
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
  metadata?: Record<string, any>;
}

export interface ToolCall {
  id: string;
  toolId: string;
  parameters: Record<string, any>;
  result?: ToolExecutionResult;
  error?: string;
}

// Conversation state management
export interface ConversationState {
  id: string;
  messages: Message[];
  context: Record<string, any>;
  activeTools: string[];
  preferences: AgentPreferences;
  metadata: Record<string, any>;
}

export interface AgentPreferences {
  verbosity: 'minimal' | 'normal' | 'detailed';
  autoExecute: boolean;
  maxToolCalls: number;
  safetyLevel: 'low' | 'medium' | 'high';
  allowedCategories: string[];
  preferredTools: string[];
}

// Tool execution planning
export interface ExecutionPlan {
  toolCalls: PlannedToolCall[];
  reasoning: string;
  confidence: number;
  alternatives: ExecutionPlan[];
}

export interface PlannedToolCall {
  toolId: string;
  parameters: Record<string, any>;
  priority: number;
  dependencies: string[];
  reason: string;
}

// Streaming response handling
export interface StreamingResponse {
  id: string;
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export type StreamingCallback = (response: StreamingResponse) => void;

// Context management
export interface ContextManager {
  getContext(conversationId: string): Record<string, any>;
  updateContext(conversationId: string, updates: Record<string, any>): void;
  clearContext(conversationId: string): void;
  summarizeContext(conversationId: string): string;
}

export class InMemoryContextManager implements ContextManager {
  private contexts: Map<string, Record<string, any>> = new Map();
  
  getContext(conversationId: string): Record<string, any> {
    return this.contexts.get(conversationId) || {};
  }
  
  updateContext(conversationId: string, updates: Record<string, any>): void {
    const current = this.getContext(conversationId);
    this.contexts.set(conversationId, { ...current, ...updates });
  }
  
  clearContext(conversationId: string): void {
    this.contexts.delete(conversationId);
  }
  
  summarizeContext(conversationId: string): string {
    const context = this.getContext(conversationId);
    const entries = Object.entries(context);
    if (entries.length === 0) return 'No context available';
    
    return entries
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ');
  }
}

// Tool execution planner
export class ToolExecutionPlanner {
  constructor(
    private registry: ToolRegistry,
    private executionManager: ExecutionEnvironmentManager
  ) {}
  
  async planExecution(
    query: string,
    context: Record<string, any>,
    preferences: AgentPreferences
  ): Promise<ExecutionPlan> {
    // Analyze query to determine intent and required tools
    const intent = this.analyzeIntent(query);
    const availableTools = await this.getRelevantTools(intent, preferences);
    
    // Generate execution plan
    const toolCalls = await this.generateToolCalls(intent, availableTools, context);
    const reasoning = this.generateReasoning(intent, toolCalls);
    
    return {
      toolCalls,
      reasoning,
      confidence: this.calculateConfidence(intent, toolCalls),
      alternatives: await this.generateAlternatives(intent, availableTools, context)
    };
  }
  
  private analyzeIntent(query: string): {
    type: string;
    entities: string[];
    keywords: string[];
    complexity: number;
  } {
    // Simple intent analysis - in production this would use NLP
    const keywords = query.toLowerCase().split(' ').filter(word => word.length > 2);
    const entities = keywords.filter(word => /^[A-Z]/.test(word));
    
    let type = 'general';
    if (keywords.some(k => ['search', 'find', 'lookup'].includes(k))) type = 'search';
    if (keywords.some(k => ['calculate', 'compute', 'math'].includes(k))) type = 'calculation';
    if (keywords.some(k => ['code', 'program', 'script'].includes(k))) type = 'code';
    if (keywords.some(k => ['api', 'request', 'call'].includes(k))) type = 'api';
    
    return {
      type,
      entities,
      keywords,
      complexity: Math.min(keywords.length / 5, 1)
    };
  }
  
  private async getRelevantTools(
    intent: any,
    preferences: AgentPreferences
  ): Promise<ToolDefinition[]> {
    const searchQuery = intent.keywords.join(' ') + ' ' + intent.type;
    
    // Search without category filter first (more tools found)
    let results = await this.registry.search(searchQuery, {
      limit: preferences.maxToolCalls * 3
    });
    
    // If no results with query, try broader search
    if (results.length === 0) {
      results = await this.registry.search(intent.type, {
        limit: preferences.maxToolCalls * 2
      });
    }
    
    // If still no results, get all tools and filter manually
    if (results.length === 0) {
      const allTools = await this.registry.list();
      results = allTools;
    }
    
    // Filter by allowed categories (manual filtering since registry filter may be broken)
    const filteredResults = results.filter(tool => 
      preferences.allowedCategories.length === 0 || 
      preferences.allowedCategories.some(cat => 
        tool.category.includes(cat) || 
        cat.includes(tool.category) ||
        this.categoryMatches(tool.category, cat)
      )
    );
    
    return filteredResults.slice(0, preferences.maxToolCalls * 2);
  }
  
  private categoryMatches(toolCategory: string, allowedCategory: string): boolean {
    // Enhanced category matching
    const categoryMap = {
      'integration': ['api', 'http'],
      'search': ['web', 'find', 'lookup'],
      'utility': ['text', 'processing', 'function'],
      'core': ['ai', 'llm', 'chat', 'embedding'],
      'data': ['knowledge', 'database', 'storage']
    };
    
    // Direct match
    if (toolCategory === allowedCategory) return true;
    
    // Check if tool category maps to allowed category
    const mappedCategories = categoryMap[toolCategory] || [];
    if (mappedCategories.includes(allowedCategory)) return true;
    
    // Check reverse mapping
    const allowedMapped = categoryMap[allowedCategory] || [];
    if (allowedMapped.includes(toolCategory)) return true;
    
    return false;
  }
  
  private async generateToolCalls(
    intent: any,
    tools: ToolDefinition[],
    context: Record<string, any>
  ): Promise<PlannedToolCall[]> {
    const toolCalls: PlannedToolCall[] = [];
    
    for (const tool of tools.slice(0, 5)) { // Limit to 5 tools max
      const parameters = await this.generateParameters(tool, intent, context);
      if (parameters) {
        toolCalls.push({
          toolId: tool.id,
          parameters,
          priority: this.calculatePriority(tool, intent),
          dependencies: this.findDependencies(tool, toolCalls),
          reason: this.generateToolReason(tool, intent)
        });
      }
    }
    
    return toolCalls.sort((a, b) => b.priority - a.priority);
  }
  
  private async generateParameters(
    tool: ToolDefinition,
    intent: any,
    context: Record<string, any>
  ): Promise<Record<string, any> | null> {
    // Fix schema access - check both possible schema locations
    const schema = tool.inputSchema || tool.input?.schema;
    if (!schema) return {};
    
    const parameters: Record<string, any> = {};
    const query = intent.keywords.join(' ');
    
    // Enhanced parameter generation based on tool type and intent
    if (schema.properties) {
      
              // Memory/Context Tools
        if (tool.id.includes('memory') || tool.category === 'utility' && tool.name.toLowerCase().includes('memory')) {
          if ('action' in schema.properties) {
                      // Determine action based on query intent - enhanced recall detection
            if (intent.keywords.some(k => ['what', 'tell', 'recall', 'remember', 'said', 'did', 'where', 'when', 'how', 'who'].includes(k.toLowerCase())) ||
                query.includes('?') || query.toLowerCase().includes('about')) {
            parameters.action = 'recall';
            // Extract memory key from query
            if (intent.keywords.includes('name')) parameters.key = 'name';
            else if (intent.keywords.some(k => ['profession', 'job', 'work'].includes(k))) parameters.key = 'profession';
            else if (intent.keywords.some(k => ['location', 'where', 'place'].includes(k))) parameters.key = 'location';
            else if (intent.keywords.some(k => ['interest', 'like', 'hobby'].includes(k))) parameters.key = 'interests';
            else parameters.key = 'general';
          } else {
            parameters.action = 'store';
            // Extract key-value pairs from declarative statements
            if (intent.keywords.includes('name')) {
              parameters.key = 'name';
              // Extract name after "name is" or "I'm"
              const nameMatch = query.match(/(?:name is|i'm|called)\s+(\w+)/i);
              if (nameMatch) parameters.value = nameMatch[1];
            } else if (intent.keywords.some(k => ['engineer', 'developer', 'scientist', 'teacher'].includes(k))) {
              parameters.key = 'profession';
              parameters.value = intent.keywords.find(k => ['engineer', 'developer', 'scientist', 'teacher', 'manager'].includes(k)) || 'professional';
            } else if (intent.keywords.some(k => ['work', 'company', 'office'].includes(k))) {
              parameters.key = 'workplace';
              parameters.value = query;
            } else if (intent.keywords.some(k => ['like', 'love', 'enjoy', 'interest'].includes(k))) {
              parameters.key = 'interests';
              parameters.value = query;
            } else {
              parameters.key = 'general';
              parameters.value = query;
            }
          }
        }
        
                  // Add query for context
          if ('query' in schema.properties) {
            parameters.query = query;
          }
      }
      
              // Generic parameter handling for other tools
        for (const [param, paramSchema] of Object.entries(schema.properties)) {
        if (!parameters[param]) { // Don't override specific logic above
          if (param === 'query' || param === 'question') {
            parameters[param] = query;
          } else if (param === 'text' || param === 'content') {
            parameters[param] = query;
          } else if (param === 'url' && intent.keywords.some(k => k.includes('http'))) {
            parameters[param] = intent.keywords.find(k => k.includes('http'));
          } else if (context[param]) {
            parameters[param] = context[param];
          }
        }
      }
    }
    
    return Object.keys(parameters).length > 0 ? parameters : null;
  }
  
  private calculatePriority(tool: ToolDefinition, intent: any): number {
    let priority = 0.3; // Base priority for all tools
    
    // Enhanced priority scoring based on tool-intent matching
    
    // Intent type matching
    if (intent.type === 'search' && this.categoryMatches(tool.category, 'search')) priority += 0.4;
    if (intent.type === 'calculation' && this.categoryMatches(tool.category, 'utility')) priority += 0.4;
    if (intent.type === 'code' && this.categoryMatches(tool.category, 'function')) priority += 0.4;
    if (intent.type === 'api' && this.categoryMatches(tool.category, 'api')) priority += 0.4;
    if (intent.type === 'general' && this.categoryMatches(tool.category, 'utility')) priority += 0.2;
    
    // Keyword matching in tool name/description
    const toolText = `${tool.name} ${tool.description || ''}`.toLowerCase();
    const keywordMatches = intent.keywords.filter(keyword => 
      toolText.includes(keyword.toLowerCase())
    ).length;
    priority += keywordMatches * 0.1;
    
    // Special case handling
    if (intent.keywords.includes('search') && tool.id.includes('search')) priority += 0.3;
    if (intent.keywords.includes('api') && tool.id.includes('api')) priority += 0.3;
    if (intent.keywords.includes('text') && tool.id.includes('text')) priority += 0.3;
    if (intent.keywords.includes('math') && tool.id.includes('processing')) priority += 0.2;
    if (intent.keywords.some(k => ['calculate', 'compute', '+', '-', '*', '/'].includes(k))) {
      if (tool.id.includes('processing') || tool.id.includes('llm')) priority += 0.3;
    }
    
    return Math.min(priority, 1);
  }
  
  private findDependencies(tool: ToolDefinition, existingCalls: PlannedToolCall[]): string[] {
    // Simple dependency detection - in production this would be more sophisticated
    const dependencies: string[] = [];
    
    if (tool.category === 'execution' && existingCalls.some(c => c.toolId.includes('search'))) {
      dependencies.push(existingCalls.find(c => c.toolId.includes('search'))?.toolId || '');
    }
    
    return dependencies.filter(d => d);
  }
  
  private generateToolReason(tool: ToolDefinition, intent: any): string {
    return `Using ${tool.name} to ${intent.type} based on query intent`;
  }
  
  private generateReasoning(intent: any, toolCalls: PlannedToolCall[]): string {
    return `Based on the query intent (${intent.type}), I'll use ${toolCalls.length} tools: ${toolCalls.map(tc => tc.toolId).join(', ')}`;
  }
  
  private calculateConfidence(intent: any, toolCalls: PlannedToolCall[]): number {
    if (toolCalls.length === 0) return 0;
    
    const avgPriority = toolCalls.reduce((sum, tc) => sum + tc.priority, 0) / toolCalls.length;
    const complexityFactor = 1 - (intent.complexity * 0.2);
    
    return Math.min(avgPriority * complexityFactor, 1);
  }
  
  private async generateAlternatives(
    intent: any,
    tools: ToolDefinition[],
    context: Record<string, any>
  ): Promise<ExecutionPlan[]> {
    // Generate up to 2 alternative plans
    const alternatives: ExecutionPlan[] = [];
    
    // Alternative 1: Use fewer tools
    if (tools.length > 1) {
      const altToolCalls = await this.generateToolCalls(intent, tools.slice(0, 2), context);
      alternatives.push({
        toolCalls: altToolCalls,
        reasoning: `Simplified approach using ${altToolCalls.length} tools`,
        confidence: this.calculateConfidence(intent, altToolCalls) * 0.8,
        alternatives: []
      });
    }
    
    return alternatives;
  }
}

// Main agent orchestrator
export class AgentOrchestrator {
  private conversations: Map<string, ConversationState> = new Map();
  private planner: ToolExecutionPlanner;
  private contextManager: ContextManager;
  
  constructor(
    private registry: ToolRegistry = new InMemoryToolRegistry(),
    private executionManager: ExecutionEnvironmentManager = new ExecutionEnvironmentManager(),
    contextManager?: ContextManager
  ) {
    this.planner = new ToolExecutionPlanner(registry, executionManager);
    this.contextManager = contextManager || new InMemoryContextManager();
  }
  
  // Start a new conversation
  createConversation(preferences?: Partial<AgentPreferences>): string {
    const id = this.generateId();
    const conversation: ConversationState = {
      id,
      messages: [],
      context: {},
      activeTools: [],
      preferences: {
        verbosity: 'normal',
        autoExecute: true,
        maxToolCalls: 3,
        safetyLevel: 'medium',
        allowedCategories: ['knowledge', 'search', 'utility', 'ai'],
        preferredTools: [],
        ...preferences
      },
      metadata: {
        created: new Date(),
        lastActivity: new Date()
      }
    };
    
    this.conversations.set(id, conversation);
    return id;
  }
  
  // Process a user message with streaming response
  async processMessage(
    conversationId: string,
    content: string,
    streamingCallback?: StreamingCallback
  ): Promise<Message> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new AgentError('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }
    
    // Add user message
    const userMessage: Message = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: new Date()
    };
    conversation.messages.push(userMessage);
    
    // Stream thinking process
    if (streamingCallback) {
      streamingCallback({
        id: this.generateId(),
        type: 'thinking',
        content: 'Analyzing your request...',
        timestamp: new Date()
      });
    }
    
    try {
      // Plan execution with combined context
      const contextManagerData = this.contextManager.getContext(conversationId);
      const conversationContext = conversation.context || {};
      const combinedContext = { ...contextManagerData, ...conversationContext };
      const plan = await this.planner.planExecution(content, combinedContext, conversation.preferences);
      
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'thinking',
          content: plan.reasoning,
          timestamp: new Date()
        });
      }
      
      // Execute tools if auto-execute is enabled
      const toolCalls: ToolCall[] = [];
      let assistantContent = '';
      
      if (conversation.preferences.autoExecute && plan.toolCalls.length > 0) {
        for (const plannedCall of plan.toolCalls) {
          const toolCall = await this.executeToolCall(
            conversationId,
            plannedCall,
            streamingCallback
          );
          toolCalls.push(toolCall);
          
          // Update context based on tool results
          if (toolCall.result?.success) {
            // Update context manager
            this.contextManager.updateContext(conversationId, {
              [`${plannedCall.toolId}_result`]: toolCall.result.data
            });
            
            // Also update conversation context directly to ensure synchronization
            const conversation = this.conversations.get(conversationId);
            if (conversation) {
              const contextUpdates = this.contextManager.getContext(conversationId);
              conversation.context = { ...conversation.context, ...contextUpdates };
              
              // Extract and store meaningful information from memory tool results
              if (plannedCall.toolId.includes('memory') && toolCall.result.data) {
                const memoryData = toolCall.result.data;
                if (memoryData.memories && typeof memoryData.memories === 'object') {
                  conversation.context = { ...conversation.context, ...memoryData.memories };
                }
              }
            }
          }
        }
        
        // Generate response based on tool results
        assistantContent = this.generateResponseFromResults(toolCalls, plan);
      } else {
        assistantContent = this.generatePlanResponse(plan);
      }
      
      // Create assistant response
      const assistantMessage: Message = {
        id: this.generateId(),
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };
      
      conversation.messages.push(assistantMessage);
      conversation.metadata.lastActivity = new Date();
      
      // Stream final response
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'text',
          content: assistantContent,
          timestamp: new Date()
        });
      }
      
      return assistantMessage;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'error',
          content: errorMessage,
          timestamp: new Date()
        });
      }
      
      throw error;
    }
  }
  
  // Execute a single tool call
  private async executeToolCall(
    conversationId: string,
    plannedCall: PlannedToolCall,
    streamingCallback?: StreamingCallback
  ): Promise<ToolCall> {
    const toolCall: ToolCall = {
      id: this.generateId(),
      toolId: plannedCall.toolId,
      parameters: plannedCall.parameters
    };
    
    try {
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'tool_call',
          content: `Executing ${plannedCall.toolId}...`,
          timestamp: new Date()
        });
      }
      
      const tool = await this.registry.get(plannedCall.toolId);
      if (!tool) {
        throw new ToolExecutionError(`Tool ${plannedCall.toolId} not found`, 'TOOL_NOT_FOUND');
      }
      
      // Execute tool directly via its implementation handler
      const startTime = Date.now();
      const rawResult = await tool.implementation.handler(plannedCall.parameters);
      const executionTime = Date.now() - startTime;
      
      // Convert tool result to standardized ToolExecutionResult format
      const result = {
        success: rawResult.success !== false, // Default to true unless explicitly false
        data: rawResult.result || rawResult.output || rawResult,
        error: rawResult.error,
        processingTime: executionTime,
        metadata: {
          toolId: plannedCall.toolId,
          parameters: plannedCall.parameters,
          executionTime
        }
      };
      
      toolCall.result = result;
      
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'tool_result',
          content: result.success ? 'Tool executed successfully' : 'Tool execution failed',
          timestamp: new Date(),
          metadata: { toolId: plannedCall.toolId, result }
        });
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toolCall.error = errorMessage;
      
      if (streamingCallback) {
        streamingCallback({
          id: this.generateId(),
          type: 'error',
          content: `Tool execution failed: ${errorMessage}`,
          timestamp: new Date()
        });
      }
    }
    
    return toolCall;
  }
  
  // Generate response from tool results
  private generateResponseFromResults(toolCalls: ToolCall[], plan: ExecutionPlan): string {
    const successfulCalls = toolCalls.filter(tc => tc.result?.success);
    const failedCalls = toolCalls.filter(tc => tc.error || !tc.result?.success);
    
    let response = '';
    
    if (successfulCalls.length > 0) {
      response += `I've executed ${successfulCalls.length} tool(s) successfully:\n\n`;
      
      for (const call of successfulCalls) {
        response += `**${call.toolId}**: ${this.formatToolResult(call.result!)}\n`;
      }
    }
    
    if (failedCalls.length > 0) {
      response += `\n${failedCalls.length} tool(s) failed to execute:\n`;
      for (const call of failedCalls) {
        response += `- ${call.toolId}: ${call.error || 'Unknown error'}\n`;
      }
    }
    
    return response.trim();
  }
  
  // Generate response when tools aren't auto-executed
  private generatePlanResponse(plan: ExecutionPlan): string {
    let response = `I've analyzed your request and created an execution plan:\n\n`;
    response += `**Reasoning**: ${plan.reasoning}\n`;
    response += `**Confidence**: ${(plan.confidence * 100).toFixed(1)}%\n\n`;
    
    if (plan.toolCalls.length > 0) {
      response += `**Planned Tools**:\n`;
      for (const call of plan.toolCalls) {
        response += `- ${call.toolId}: ${call.reason}\n`;
      }
      response += `\nWould you like me to execute these tools?`;
    }
    
    return response;
  }
  
  // Format tool result for display
  private formatToolResult(result: ToolExecutionResult): string {
    if (typeof result.data === 'string') {
      return result.data.length > 200 ? result.data.substring(0, 200) + '...' : result.data;
    }
    
    return JSON.stringify(result.data, null, 2);
  }
  
  // Get conversation history
  getConversation(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId);
  }
  
  // List all conversations
  listConversations(): ConversationState[] {
    return Array.from(this.conversations.values());
  }
  
  // Delete conversation
  deleteConversation(conversationId: string): boolean {
    this.contextManager.clearContext(conversationId);
    return this.conversations.delete(conversationId);
  }
  
  // Update conversation preferences
  updatePreferences(conversationId: string, preferences: Partial<AgentPreferences>): boolean {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return false;
    
    conversation.preferences = { ...conversation.preferences, ...preferences };
    return true;
  }
  
  // Generate unique ID
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

// Utility functions for agent operations
export class AgentUtils {
  static formatMessage(message: Message, includeMetadata = false): string {
    const timestamp = message.timestamp.toLocaleString();
    let formatted = `[${timestamp}] ${message.role.toUpperCase()}: ${message.content}`;
    
    if (message.toolCalls && message.toolCalls.length > 0) {
      formatted += `\nTool Calls: ${message.toolCalls.length}`;
    }
    
    if (includeMetadata && message.metadata) {
      formatted += `\nMetadata: ${JSON.stringify(message.metadata)}`;
    }
    
    return formatted;
  }
  
  static exportConversation(conversation: ConversationState): string {
    const lines = [
      `Conversation ID: ${conversation.id}`,
      `Created: ${conversation.metadata.created}`,
      `Last Activity: ${conversation.metadata.lastActivity}`,
      `Messages: ${conversation.messages.length}`,
      '',
      '--- MESSAGES ---'
    ];
    
    for (const message of conversation.messages) {
      lines.push(this.formatMessage(message));
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  static summarizeConversation(conversation: ConversationState): string {
    const messageCount = conversation.messages.length;
    const userMessages = conversation.messages.filter(m => m.role === 'user').length;
    const toolCalls = conversation.messages.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0);
    
    return `Conversation with ${messageCount} messages (${userMessages} user messages), ${toolCalls} tool calls executed`;
  }
} 