/**
 * GraphQL query complexity analyzer (Section 8.7).
 *
 * Enforces:
 * - Depth limit (max nesting of selection sets)
 * - Breadth limit (max fields per selection set level)
 * - Cost-based complexity with configurable weights
 *
 * Operates on raw GraphQL query strings via the graphql parser.
 */

import {
  parse,
  visit,
  Kind,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
} from 'graphql';
import { createOpenFoundryError } from '../graphql/errors.js';

/** Complexity analyzer configuration. */
export interface ComplexityConfig {
  /** Maximum query depth (default: 10). */
  maxDepth: number;
  /** Maximum fields at any single level (default: 50). */
  maxBreadth: number;
  /** Maximum total cost (default: 1000). */
  maxCost: number;
  /** Default cost per field (default: 1). */
  defaultFieldCost: number;
  /** Cost multiplier for list fields (default: 10). */
  listCostMultiplier: number;
  /** Custom cost overrides by type.field path. */
  fieldCosts?: Record<string, number>;
}

/** Result of complexity analysis. */
export interface ComplexityAnalysis {
  valid: boolean;
  depth: number;
  maxBreadth: number;
  totalCost: number;
  violations: string[];
}

const DEFAULT_CONFIG: ComplexityConfig = {
  maxDepth: 10,
  maxBreadth: 50,
  maxCost: 1000,
  defaultFieldCost: 1,
  listCostMultiplier: 10,
  fieldCosts: {},
};

/**
 * Analyze a GraphQL query for depth, breadth, and cost.
 */
export class QueryComplexityAnalyzer {
  private readonly config: ComplexityConfig;

  constructor(config?: Partial<ComplexityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze a query string or pre-parsed document.
   */
  analyze(queryOrDoc: string | DocumentNode): ComplexityAnalysis {
    const doc = typeof queryOrDoc === 'string' ? parse(queryOrDoc) : queryOrDoc;

    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of doc.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def);
      }
    }

    let maxDepth = 0;
    let maxBreadthFound = 0;
    let totalCost = 0;
    const violations: string[] = [];

    for (const def of doc.definitions) {
      if (def.kind === Kind.OPERATION_DEFINITION) {
        const result = this.analyzeOperation(def, fragments);
        maxDepth = Math.max(maxDepth, result.depth);
        maxBreadthFound = Math.max(maxBreadthFound, result.maxBreadth);
        totalCost += result.totalCost;
      }
    }

    if (maxDepth > this.config.maxDepth) {
      violations.push(
        `Query depth ${maxDepth} exceeds maximum ${this.config.maxDepth}`,
      );
    }
    if (maxBreadthFound > this.config.maxBreadth) {
      violations.push(
        `Query breadth ${maxBreadthFound} exceeds maximum ${this.config.maxBreadth}`,
      );
    }
    if (totalCost > this.config.maxCost) {
      violations.push(
        `Query cost ${totalCost} exceeds maximum ${this.config.maxCost}`,
      );
    }

    return {
      valid: violations.length === 0,
      depth: maxDepth,
      maxBreadth: maxBreadthFound,
      totalCost,
      violations,
    };
  }

  /**
   * Create a QUERY_TOO_COMPLEX error from an analysis result.
   */
  createComplexityError(analysis: ComplexityAnalysis): ReturnType<typeof createOpenFoundryError> {
    return createOpenFoundryError({
      code: 'QUERY_TOO_COMPLEX',
      category: 'validation',
      message: `Query too complex: ${analysis.violations.join('; ')}`,
      retryable: false,
      details: {
        depth: analysis.depth,
        maxBreadth: analysis.maxBreadth,
        totalCost: analysis.totalCost,
        violations: analysis.violations,
      },
    });
  }

  private analyzeOperation(
    operation: OperationDefinitionNode,
    fragments: Map<string, FragmentDefinitionNode>,
  ): { depth: number; maxBreadth: number; totalCost: number } {
    let maxDepth = 0;
    let maxBreadth = 0;
    let totalCost = 0;
    let currentDepth = 0;

    // Track breadth at each depth level
    const breadthByDepth = new Map<number, number>();

    visit(operation, {
      Field: {
        enter: (node: FieldNode) => {
          currentDepth++;
          if (currentDepth > maxDepth) {
            maxDepth = currentDepth;
          }

          // Track breadth at this depth
          const current = breadthByDepth.get(currentDepth) ?? 0;
          breadthByDepth.set(currentDepth, current + 1);
          if (current + 1 > maxBreadth) {
            maxBreadth = current + 1;
          }

          // Calculate cost
          const fieldName = node.name.value;
          const customCost = this.config.fieldCosts?.[fieldName];
          if (customCost !== undefined) {
            totalCost += customCost;
          } else if (node.selectionSet) {
            // Fields with sub-selections are likely object/list types
            totalCost += this.config.defaultFieldCost * this.config.listCostMultiplier;
          } else {
            totalCost += this.config.defaultFieldCost;
          }
        },
        leave: () => {
          currentDepth--;
        },
      },
      InlineFragment: {
        enter: (_node: InlineFragmentNode) => {
          // Inline fragments don't add depth but we still traverse
        },
      },
      FragmentSpread: {
        enter: (node) => {
          const fragment = fragments.get(node.name.value);
          if (fragment) {
            // Analyze fragment inline (simplified — doesn't handle cycles)
            const result = this.analyzeSelectionSet(fragment, fragments, currentDepth);
            if (result.depth > maxDepth) maxDepth = result.depth;
            if (result.maxBreadth > maxBreadth) maxBreadth = result.maxBreadth;
            totalCost += result.totalCost;
          }
          return false; // Don't visit children (we handled it manually)
        },
      },
    });

    return { depth: maxDepth, maxBreadth, totalCost };
  }

  private analyzeSelectionSet(
    node: FragmentDefinitionNode | InlineFragmentNode,
    fragments: Map<string, FragmentDefinitionNode>,
    startDepth: number,
  ): { depth: number; maxBreadth: number; totalCost: number } {
    let maxDepth = startDepth;
    let maxBreadth = 0;
    let totalCost = 0;
    let currentDepth = startDepth;

    visit(node, {
      Field: {
        enter: (fieldNode: FieldNode) => {
          currentDepth++;
          if (currentDepth > maxDepth) maxDepth = currentDepth;

          const fieldName = fieldNode.name.value;
          const customCost = this.config.fieldCosts?.[fieldName];
          if (customCost !== undefined) {
            totalCost += customCost;
          } else if (fieldNode.selectionSet) {
            totalCost += this.config.defaultFieldCost * this.config.listCostMultiplier;
          } else {
            totalCost += this.config.defaultFieldCost;
          }
        },
        leave: () => {
          currentDepth--;
        },
      },
      FragmentSpread: {
        enter: (spreadNode) => {
          const fragment = fragments.get(spreadNode.name.value);
          if (fragment) {
            const result = this.analyzeSelectionSet(fragment, fragments, currentDepth);
            if (result.depth > maxDepth) maxDepth = result.depth;
            if (result.maxBreadth > maxBreadth) maxBreadth = result.maxBreadth;
            totalCost += result.totalCost;
          }
          return false;
        },
      },
    });

    // Count breadth as number of direct field selections
    if (node.selectionSet) {
      const directFields = node.selectionSet.selections.filter(
        s => s.kind === Kind.FIELD,
      ).length;
      if (directFields > maxBreadth) maxBreadth = directFields;
    }

    return { depth: maxDepth, maxBreadth, totalCost };
  }
}
