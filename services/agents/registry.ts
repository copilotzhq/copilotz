/**
 * Agentic Tool Framework - Tool Registry
 * Central management system for tool registration, validation, and discovery
 */

import type {
  ToolDefinition,
  ToolRegistry,
  ToolType,
  ToolCategory,
  ListOptions,
  SearchOptions,
  ValidationResult,
  ValidationError,
  ToolValidationError,
  JSONSchema
} from './types.ts';

// =============================================================================
// IN-MEMORY TOOL REGISTRY IMPLEMENTATION
// =============================================================================

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private readonly categoryIndex = new Map<ToolCategory, Set<string>>();
  private readonly typeIndex = new Map<ToolType, Set<string>>();
  private readonly tagIndex = new Map<string, Set<string>>();

  constructor() {
    this.initializeIndexes();
  }

  private initializeIndexes(): void {
    // Initialize category index
    const categories: ToolCategory[] = ['core', 'integration', 'execution', 'data', 'search', 'utility'];
    categories.forEach(category => this.categoryIndex.set(category, new Set()));

    // Initialize type index  
    const types: ToolType[] = [
      'function', 'api', 'knowledge', 'ai', 'web_search', 
      'js_execution', 'py_execution', 'mcp_server', 'file_system', 
      'database', 'workflow'
    ];
    types.forEach(type => this.typeIndex.set(type, new Set()));
  }

  /**
   * Register a new tool in the registry
   */
  async register(tool: ToolDefinition): Promise<void> {
    console.log(`🔧 Registering tool: ${tool.id} (${tool.type})`);

    // Validate tool definition
    const validation = await this.validate(tool);
    if (!validation.valid) {
      throw new ToolValidationError(
        `Tool validation failed for ${tool.id}`, 
        validation.errors || []
      );
    }

    // Check for ID conflicts
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with ID '${tool.id}' already exists`);
    }

    // Register the tool
    this.tools.set(tool.id, tool);

    // Update indexes
    this.updateIndexes(tool, 'add');

    console.log(`✅ Tool registered: ${tool.id} v${tool.version}`);
  }

  /**
   * Unregister a tool from the registry
   */
  async unregister(toolId: string): Promise<void> {
    console.log(`🗑️ Unregistering tool: ${toolId}`);

    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool '${toolId}' not found`);
    }

    // Remove from indexes
    this.updateIndexes(tool, 'remove');

    // Remove the tool
    this.tools.delete(toolId);

    console.log(`✅ Tool unregistered: ${toolId}`);
  }

  /**
   * Get a specific tool by ID
   */
  async get(toolId: string): Promise<ToolDefinition | null> {
    return this.tools.get(toolId) || null;
  }

  /**
   * List tools with optional filtering
   */
  async list(options: ListOptions = {}): Promise<ToolDefinition[]> {
    let results = Array.from(this.tools.values());

    // Apply filters
    if (options.category) {
      results = results.filter(tool => tool.category === options.category);
    }

    if (options.type) {
      results = results.filter(tool => tool.type === options.type);
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter(tool => 
        options.tags!.some(tag => tool.metadata.tags.includes(tag))
      );
    }

    if (!options.includeDeprecated) {
      results = results.filter(tool => !tool.metadata.deprecated);
    }

    if (!options.includeExperimental) {
      results = results.filter(tool => !tool.metadata.experimental);
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Search tools by query string
   */
  async search(query: string, options: SearchOptions = {}): Promise<ToolDefinition[]> {
    const normalizedQuery = query.toLowerCase().trim();
    
    if (!normalizedQuery) {
      return this.list(options);
    }

    let results = Array.from(this.tools.values());

    // Text-based search across multiple fields
    results = results.filter(tool => {
      const searchableText = [
        tool.name,
        tool.description,
        tool.id,
        ...tool.metadata.tags
      ].join(' ').toLowerCase();

      if (options.fuzzy) {
        // Simple fuzzy matching
        return this.fuzzyMatch(normalizedQuery, searchableText);
      } else {
        // Exact substring matching
        return searchableText.includes(normalizedQuery);
      }
    });

    // Apply additional filters
    results = await this.applyListFilters(results, options);

    // Sort by relevance (basic scoring)
    results = this.scoreAndSort(results, normalizedQuery);

    // Apply limit
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Validate a tool definition
   */
  async validate(tool: ToolDefinition): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    // Required field validation
    if (!tool.id || tool.id.trim() === '') {
      errors.push({
        path: 'id',
        message: 'Tool ID is required',
        code: 'REQUIRED_FIELD'
      });
    }

    if (!tool.name || tool.name.trim() === '') {
      errors.push({
        path: 'name',
        message: 'Tool name is required',
        code: 'REQUIRED_FIELD'
      });
    }

    if (!tool.description || tool.description.trim() === '') {
      errors.push({
        path: 'description',
        message: 'Tool description is required',
        code: 'REQUIRED_FIELD'
      });
    }

    // ID format validation
    if (tool.id && !/^[a-zA-Z0-9_-]+$/.test(tool.id)) {
      errors.push({
        path: 'id',
        message: 'Tool ID must contain only alphanumeric characters, hyphens, and underscores',
        code: 'INVALID_FORMAT'
      });
    }

    // Version validation
    if (!tool.version || !/^\d+\.\d+\.\d+$/.test(tool.version)) {
      errors.push({
        path: 'version',
        message: 'Tool version must follow semantic versioning (e.g., 1.0.0)',
        code: 'INVALID_FORMAT'
      });
    }

    // Schema validation
    if (!this.isValidJSONSchema(tool.input.schema)) {
      errors.push({
        path: 'input.schema',
        message: 'Invalid input schema',
        code: 'INVALID_SCHEMA'
      });
    }

    if (!this.isValidJSONSchema(tool.output.schema)) {
      errors.push({
        path: 'output.schema',
        message: 'Invalid output schema',
        code: 'INVALID_SCHEMA'
      });
    }

    // Permissions validation
    if (!tool.permissions) {
      errors.push({
        path: 'permissions',
        message: 'Tool permissions are required',
        code: 'REQUIRED_FIELD'
      });
    }

    // Execution validation
    if (!tool.execution) {
      errors.push({
        path: 'execution',
        message: 'Tool execution configuration is required',
        code: 'REQUIRED_FIELD'
      });
    }

    // Resource limits validation
    if (tool.execution?.resourceLimits) {
      const limits = tool.execution.resourceLimits;
      
      if (limits.maxMemoryMB && limits.maxMemoryMB <= 0) {
        errors.push({
          path: 'execution.resourceLimits.maxMemoryMB',
          message: 'Memory limit must be positive',
          code: 'INVALID_VALUE'
        });
      }

      if (limits.maxExecutionTimeMs && limits.maxExecutionTimeMs <= 0) {
        errors.push({
          path: 'execution.resourceLimits.maxExecutionTimeMs',
          message: 'Execution time limit must be positive',
          code: 'INVALID_VALUE'
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const tools = Array.from(this.tools.values());
    
    const stats: RegistryStats = {
      totalTools: tools.length,
      byCategory: {},
      byType: {},
      deprecated: tools.filter(t => t.metadata.deprecated).length,
      experimental: tools.filter(t => t.metadata.experimental).length,
      recentlyAdded: tools.filter(t => {
        // Assume tools are "recent" if no creation date is available
        return true;
      }).length
    };

    // Count by category
    for (const category of this.categoryIndex.keys()) {
      stats.byCategory[category] = this.categoryIndex.get(category)?.size || 0;
    }

    // Count by type
    for (const type of this.typeIndex.keys()) {
      stats.byType[type] = this.typeIndex.get(type)?.size || 0;
    }

    return stats;
  }

  /**
   * Get all available tool IDs
   */
  getToolIds(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  /**
   * Check if a tool exists
   */
  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /**
   * Clear all tools (useful for testing)
   */
  clear(): void {
    this.tools.clear();
    this.categoryIndex.forEach(set => set.clear());
    this.typeIndex.forEach(set => set.clear());
    this.tagIndex.clear();
  }

  // =============================================================================
  // PRIVATE HELPER METHODS
  // =============================================================================

  private updateIndexes(tool: ToolDefinition, operation: 'add' | 'remove'): void {
    const toolId = tool.id;

    // Update category index
    const categorySet = this.categoryIndex.get(tool.category);
    if (categorySet) {
      if (operation === 'add') {
        categorySet.add(toolId);
      } else {
        categorySet.delete(toolId);
      }
    }

    // Update type index
    const typeSet = this.typeIndex.get(tool.type);
    if (typeSet) {
      if (operation === 'add') {
        typeSet.add(toolId);
      } else {
        typeSet.delete(toolId);
      }
    }

    // Update tag index
    tool.metadata.tags.forEach(tag => {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      const tagSet = this.tagIndex.get(tag)!;
      
      if (operation === 'add') {
        tagSet.add(toolId);
      } else {
        tagSet.delete(toolId);
        // Clean up empty tag sets
        if (tagSet.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    });
  }

  private async applyListFilters(tools: ToolDefinition[], options: ListOptions): Promise<ToolDefinition[]> {
    let results = tools;

    if (options.category) {
      results = results.filter(tool => tool.category === options.category);
    }

    if (options.type) {
      results = results.filter(tool => tool.type === options.type);
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter(tool => 
        options.tags!.some(tag => tool.metadata.tags.includes(tag))
      );
    }

    if (!options.includeDeprecated) {
      results = results.filter(tool => !tool.metadata.deprecated);
    }

    if (!options.includeExperimental) {
      results = results.filter(tool => !tool.metadata.experimental);
    }

    return results;
  }

  private scoreAndSort(tools: ToolDefinition[], query: string): ToolDefinition[] {
    return tools
      .map(tool => ({
        tool,
        score: this.calculateRelevanceScore(tool, query)
      }))
      .sort((a, b) => b.score - a.score)
      .map(item => item.tool);
  }

  private calculateRelevanceScore(tool: ToolDefinition, query: string): number {
    let score = 0;
    const normalizedQuery = query.toLowerCase();

    // Exact matches get highest score
    if (tool.name.toLowerCase() === normalizedQuery) score += 100;
    if (tool.id.toLowerCase() === normalizedQuery) score += 90;

    // Starts with query
    if (tool.name.toLowerCase().startsWith(normalizedQuery)) score += 50;
    if (tool.description.toLowerCase().startsWith(normalizedQuery)) score += 30;

    // Contains query
    if (tool.name.toLowerCase().includes(normalizedQuery)) score += 20;
    if (tool.description.toLowerCase().includes(normalizedQuery)) score += 10;

    // Tag matches
    tool.metadata.tags.forEach(tag => {
      if (tag.toLowerCase().includes(normalizedQuery)) score += 15;
    });

    return score;
  }

  private fuzzyMatch(query: string, text: string): boolean {
    // Simple fuzzy matching algorithm
    let queryIndex = 0;
    
    for (let i = 0; i < text.length && queryIndex < query.length; i++) {
      if (text[i] === query[queryIndex]) {
        queryIndex++;
      }
    }
    
    return queryIndex === query.length;
  }

  private isValidJSONSchema(schema: JSONSchema): boolean {
    // Basic JSON Schema validation
    if (!schema || typeof schema !== 'object') {
      return false;
    }

    // Must have a type
    if (!schema.type) {
      return false;
    }

    // Valid types
    const validTypes = ['object', 'array', 'string', 'number', 'boolean', 'null'];
    if (!validTypes.includes(schema.type)) {
      return false;
    }

    return true;
  }
}

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface RegistryStats {
  totalTools: number;
  byCategory: Record<ToolCategory, number>;
  byType: Record<ToolType, number>;
  deprecated: number;
  experimental: number;
  recentlyAdded: number;
}

// =============================================================================
// REGISTRY FACTORY
// =============================================================================

/**
 * Create a new tool registry instance
 */
export function createToolRegistry(): ToolRegistry {
  return new InMemoryToolRegistry();
}

/**
 * Global registry instance (singleton pattern)
 */
let globalRegistry: ToolRegistry | null = null;

/**
 * Get the global tool registry instance
 */
export function getGlobalToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = createToolRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (useful for testing)
 */
export function resetGlobalToolRegistry(): void {
  globalRegistry = null;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Register multiple tools at once
 */
export async function registerTools(registry: ToolRegistry, tools: ToolDefinition[]): Promise<void> {
  console.log(`📦 Bulk registering ${tools.length} tools...`);
  
  const results = await Promise.allSettled(
    tools.map(tool => registry.register(tool))
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  console.log(`✅ Tool registration complete: ${successful} successful, ${failed} failed`);

  if (failed > 0) {
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => (r as PromiseRejectedResult).reason);
    
    console.warn('Failed registrations:', errors);
  }
}

/**
 * Validate multiple tools
 */
export async function validateTools(registry: ToolRegistry, tools: ToolDefinition[]): Promise<ValidationResult> {
  console.log(`🔍 Validating ${tools.length} tools...`);
  
  const results = await Promise.all(
    tools.map(tool => registry.validate(tool))
  );

  const allErrors: ValidationError[] = [];
  let totalValid = 0;

  results.forEach((result, index) => {
    if (result.valid) {
      totalValid++;
    } else if (result.errors) {
      // Prefix path with tool index for context
      const prefixedErrors = result.errors.map(error => ({
        ...error,
        path: `tools[${index}].${error.path}`
      }));
      allErrors.push(...prefixedErrors);
    }
  });

  console.log(`✅ Validation complete: ${totalValid}/${tools.length} tools valid`);

  return {
    valid: allErrors.length === 0,
    errors: allErrors.length > 0 ? allErrors : undefined
  };
} 