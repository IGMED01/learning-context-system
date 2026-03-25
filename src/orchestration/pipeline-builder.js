// @ts-check

/**
 * @typedef {{
 *   id: string,
 *   type: string,
 *   inputFrom?: string,
 *   params?: Record<string, unknown>,
 *   optional?: boolean
 * }} WorkflowStep
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   steps: WorkflowStep[]
 * }} WorkflowPipeline
 */

/**
 * @typedef {(context: {
 *   step: WorkflowStep,
 *   state: Record<string, unknown>,
 *   input: unknown,
 *   params: Record<string, unknown>
 * }) => Promise<unknown>} StepExecutor
 */

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {number} value
 */
function waitMs(value) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, value)));
}

/**
 * NEXUS:5 — dynamic workflow pipeline builder with pluggable executors.
 * @param {{ executors?: Record<string, StepExecutor> }} [options]
 */
export function createPipelineBuilder(options = {}) {
  /** @type {Map<string, StepExecutor>} */
  const executors = new Map(Object.entries(options.executors ?? {}));

  return {
    /**
     * @param {string} stepType
     * @param {StepExecutor} executor
     */
    registerExecutor(stepType, executor) {
      if (!stepType.trim()) {
        throw new Error("Executor step type is required.");
      }

      executors.set(stepType, executor);
      return stepType;
    },

    /**
     * @param {string} stepType
     */
    hasExecutor(stepType) {
      return executors.has(stepType);
    },

    listExecutors() {
      return [...executors.keys()].sort((left, right) => left.localeCompare(right));
    },

    /**
     * @param {WorkflowPipeline} pipeline
     * @param {unknown} input
     */
    async runPipeline(pipeline, input) {
      if (!pipeline?.id || !Array.isArray(pipeline.steps)) {
        throw new Error("Invalid pipeline: id and steps are required.");
      }

      const state = {
        input,
        steps: {}
      };
      /** @type {Array<{ stepId: string, stepType: string, status: string, durationMs: number, attempts?: number, error?: string }>} */
      const trace = [];

      for (const step of pipeline.steps) {
        const executor = executors.get(step.type);
        const startedAt = Date.now();

        if (!executor) {
          if (step.optional) {
            trace.push({
              stepId: step.id,
              stepType: step.type,
              status: "skipped",
              durationMs: 0,
              error: "missing-executor"
            });
            continue;
          }

          throw new Error(`Missing executor for step type '${step.type}' (step '${step.id}').`);
        }

        const inputKey = step.inputFrom?.trim();
        const stepInput =
          inputKey && inputKey in asRecord(state.steps)
            ? asRecord(state.steps)[inputKey]
            : input;
        const params = asRecord(step.params);
        const retryAttempts = Math.max(
          0,
          Math.min(5, Math.trunc(Number(params.retryAttempts ?? params.retries ?? 0)))
        );
        const retryDelayMs = Math.max(0, Math.trunc(Number(params.retryDelayMs ?? 0)));

        try {
          /** @type {unknown} */
          let result;
          let attempts = 0;
          /** @type {Error | null} */
          let lastError = null;

          for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
            attempts = attempt + 1;
            try {
              result = await executor({
                step,
                state,
                input: stepInput,
                params
              });
              lastError = null;
              break;
            } catch (error) {
              lastError = error instanceof Error ? error : new Error(String(error));

              if (attempt < retryAttempts) {
                if (retryDelayMs > 0) {
                  await waitMs(retryDelayMs);
                }
                continue;
              }
            }
          }

          if (lastError) {
            throw lastError;
          }

          asRecord(state.steps)[step.id] = result;

          trace.push({
            stepId: step.id,
            stepType: step.type,
            status: "ok",
            durationMs: Date.now() - startedAt,
            attempts
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          trace.push({
            stepId: step.id,
            stepType: step.type,
            status: step.optional ? "failed-optional" : "failed",
            durationMs: Date.now() - startedAt,
            attempts: retryAttempts + 1,
            error: message
          });

          if (!step.optional) {
            throw new Error(
              `Pipeline '${pipeline.id}' failed in step '${step.id}' (${step.type}): ${message}`
            );
          }
        }
      }

      return {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        state,
        trace
      };
    }
  };
}

/**
 * @returns {WorkflowPipeline}
 */
export function buildDefaultNexusPipeline() {
  return {
    id: "nexus-default-pipeline",
    name: "NEXUS default ingest→process→store→recall",
    steps: [
      {
        id: "ingest",
        type: "ingest"
      },
      {
        id: "process",
        type: "process",
        inputFrom: "ingest"
      },
      {
        id: "store",
        type: "store",
        inputFrom: "process"
      },
      {
        id: "recall",
        type: "recall",
        inputFrom: "store"
      }
    ]
  };
}
