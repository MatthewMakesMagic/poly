/**
 * Factory API Response Type Definitions (JSDoc)
 *
 * Defines the shapes returned by /api/factory/* endpoints.
 * These match the factory_runs, factory_results, and strategy_lineage
 * table schemas from the backend architecture doc.
 *
 * @module lib/factory-types
 */

/**
 * @typedef {Object} FactoryRun
 * @property {number} run_id
 * @property {string} manifest_name
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} started_at - ISO 8601 timestamp
 * @property {string|null} completed_at - ISO 8601 timestamp
 * @property {number|null} wall_clock_ms
 * @property {number} total_runs
 * @property {number} completed_runs
 * @property {FactoryRunSummary|null} summary
 * @property {string|null} error_message
 */

/**
 * @typedef {Object} FactoryRunSummary
 * @property {number} bestSharpe
 * @property {string} bestStrategy
 * @property {string} bestSymbol
 * @property {number} totalTrades
 * @property {Array<{strategy: string, symbol: string, sharpe: number}>} ranking
 */

/**
 * @typedef {Object} FactoryResult
 * @property {number} id
 * @property {number} run_id
 * @property {string} strategy_name
 * @property {string} strategy_source - 'yaml' | 'js'
 * @property {string} symbol - 'btc' | 'eth' | 'sol' | 'xrp'
 * @property {Object} config - Strategy configuration JSONB
 * @property {number} sample_size
 * @property {FactoryMetrics} metrics
 * @property {number} elapsed_ms
 * @property {string} created_at - ISO 8601 timestamp
 */

/**
 * @typedef {Object} FactoryMetrics
 * @property {number} sharpe
 * @property {number} sortino
 * @property {number} profitFactor
 * @property {number} maxDrawdown
 * @property {number} winRate - 0-1 decimal
 * @property {number} trades - integer count
 * @property {number} expectancy
 * @property {number} edgePerTrade
 * @property {number} totalPnl
 * @property {MetricRegime} [regime]
 * @property {MetricConfidenceIntervals} [confidenceIntervals]
 */

/**
 * @typedef {Object} MetricRegime
 * @property {RegimeHalf} firstHalf
 * @property {RegimeHalf} secondHalf
 * @property {Array<TimeOfDayBucket>} timeOfDay
 * @property {Array<DayOfWeekBucket>} dayOfWeek
 */

/**
 * @typedef {Object} RegimeHalf
 * @property {number} sharpe
 * @property {number} trades
 * @property {number} winRate
 */

/**
 * @typedef {Object} TimeOfDayBucket
 * @property {string} bucket - e.g. '0-3min', '3-6min'
 * @property {number} trades
 * @property {number} winRate
 * @property {number} pnl
 */

/**
 * @typedef {Object} DayOfWeekBucket
 * @property {string} day - e.g. 'Mon', 'Tue'
 * @property {number} trades
 * @property {number} sharpe
 */

/**
 * @typedef {Object} MetricConfidenceIntervals
 * @property {{lower: number, upper: number, level: number}} sharpe
 * @property {{lower: number, upper: number, level: number}} [winRate]
 */

/**
 * @typedef {Object} StrategyLineageEntry
 * @property {number} id
 * @property {string} strategy_name
 * @property {string|null} parent_name
 * @property {string} mutation_type - 'original' | 'param_perturb' | 'structural' | 'crossover'
 * @property {string} mutation_reasoning
 * @property {string} created_at - ISO 8601 timestamp
 * @property {string} created_by - 'matthew' | 'claude'
 */

/**
 * @typedef {Object} CoverageEntry
 * @property {string} symbol
 * @property {number} totalResults
 * @property {number} uniqueStrategies
 * @property {{from: string, to: string}} dateRange
 * @property {number} avgSampleSize
 * @property {{totalWindows: number, dateRange: {from: string, to: string}}|null} timeline
 */

/**
 * @typedef {Object} LeaderboardEntry
 * @extends FactoryResult
 * @property {boolean} lowSample - true if trades < 50
 */

/**
 * Standard API response wrapper.
 * All /api/factory/* endpoints return this shape.
 *
 * @template T
 * @typedef {Object} ApiResponse
 * @property {boolean} ok
 * @property {T} data
 * @property {{total: number, limit?: number, offset?: number}} meta
 */

/**
 * @typedef {{runs: FactoryRun[]}} RunsListData
 * @typedef {{run: FactoryRun}} RunDetailData
 * @typedef {{results: FactoryResult[]}} ResultsData
 * @typedef {{strategies: LeaderboardEntry[]}} LeaderboardData
 * @typedef {{lineage: StrategyLineageEntry[]}} LineageData
 * @typedef {{coverage: CoverageEntry[]}} CoverageData
 * @typedef {{comparison: FactoryResult[], warnings: string[]}} CompareData
 */

export {};
