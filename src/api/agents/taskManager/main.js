// taskManager/main.js
import validate from "axion-modules/connectors/validator.ts";

const maxIter = 3;

async function taskManager(
    {
        resources,
        answer,
        threadLogs,
        instructions,
        input,
        audio,
        user,
        thread,
        options,
        iterations = 0,
        outputSchema,
        overrideBaseOutputSchema,
        agentType,
    },
    res
) {

    agentType = agentType || 'taskManager';

    let currentStep;
    let workflow;
    let taskDoc;

    // Extract Dependencies
    const { models, modules, utils, withHooks} = this;
    const { createPrompt, getThreadHistory, jsonSchemaToShortSchema, mergeSchemas } = utils;
    const { agents } = modules;

    // Extract resources
    const { copilotz, config } = resources;

    const { job } = copilotz || {};
    const { workflows: jobWorkflows } = job || {};
    const { workflows: copilotWorkflows } = copilotz || {};
    const allWorkflows = [...(jobWorkflows || []), ...(copilotWorkflows || [])];

    const { extId: externalId } = thread;

    // 1.3 Override Base Schemas
    const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;

    // 1.4. Extract and Merge Schemas
    outputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

    // 1. Get or Create Task
    taskDoc = await models.tasks.findOne(
        { extId: externalId, status: 'active' },
        { sort: { updatedAt: -1 } }
    );

    const actionModules = {
        createTask: async (args) => {
            // Let the assistant decide which workflow to start based on user input
            const workflowName = args.workflowName;
            if (!workflowName) {
                throw new Error(`Error creating task: 'workflowName' arg is required, found: ${Object.keys(args).join(',')}`);
            };
            const selectedWorkflow = allWorkflows.filter(Boolean).find(
                (wf) => wf.name.toLowerCase() === workflowName.toLowerCase()
            );

            if (!selectedWorkflow) {
                throw new Error(`Workflow "${workflowName}" not found`);
            }

            const taskData = {
                name: selectedWorkflow.name,
                description: selectedWorkflow.description,
                context: { user, createdAt: new Date().toISOString() },
                extId: externalId,
                status: 'active',
                workflow: selectedWorkflow._id,
                currentStep: selectedWorkflow.firstStep,
            };
            const newTask = await models.tasks.create(taskData);
            return newTask
        },
        // listCurrentWorkflowSteps: () => workflow.steps.map((step) => ({ name: step.name, description: step.description })),
        // getStepDetails: ({ name }) => {
        //     const step = workflow.steps.find((step) => step.name === name);
        //     if (!step) {
        //         throw new Error(`Step "${name}" not found in workflow "${workflow.name}"`);
        //     }
        //     return step;
        // },
        submit: async (_args, onSubmit) => {

            const { _user, ...args } = _args;

            const updateTaskPayload = {};
            let status = 'completed';
            let results;

            try {
                results = onSubmit ? await onSubmit(args) : args;
            } catch (error) {
                status = 'failed';
                results = { error };
                console.error(`[taskManager] Error processing submit function:`, error);
            }

            if (status !== 'failed') {
                updateTaskPayload.currentStep = currentStep.next;
                // check if currentStep.next is the last step in the workflow
                if (!currentStep.next) {
                    updateTaskPayload.status = 'completed';
                }
            } else {
                updateTaskPayload.status = 'failed';
                if (currentStep.failedNext) {
                    updateTaskPayload.currentStep = currentStep.failedNext;
                }
            }

            // Update task context with submission details
            const updatedAt = new Date().toISOString();

            updateTaskPayload.context = {
                steps: {
                    ...taskDoc?.context?.steps,
                    [currentStep.name]: { args, results, updatedAt }
                },
                state: {
                    ...taskDoc?.context?.state,
                    ...results
                }
            }

            await models.tasks.update({ _id: taskDoc._id }, updateTaskPayload);

            return results;
        },
        changeStep: async ({ stepName }) => {
            const step = workflow.steps.find((step) => step.name === stepName);
            if (!step) {
                throw new Error(`Step "${stepName}" not found in workflow "${workflow.name}"`);
            }

            const updatedTask = await models.tasks.update({ _id: taskDoc._id }, { currentStep: step._id });
            return { name: step.name, description: step.description, id: step._id };
        },
        // listWorkflows: () => allWorkflows.filter(Boolean).map(({ name, description }) => ({ name, description })),
        cancelTask: async () => {
            await models.tasks.update({ _id: taskDoc._id }, { status: 'cancelled' });
            return { message: 'Task cancelled' };
        },
        setState: async ({ key, value }) => {
            await models.tasks.update({ _id: taskDoc._id }, { context: { ...taskDoc.context, state: { ...taskDoc.context.state, [key]: value } } });
            return { message: 'Context updated' };
        },
    };

    const actionSpecs = {
        // listWorkflows: `(lists all workflows): ->(returns array of workflow names)`,
        createTask: `(creates a new task for a given workflow): !workflowName<string>(name of the workflow to start)->(returns task object)`,
        changeStep: `(changes the current step of the working task in current workflow): !stepName<string>(name of the step to change to)->(returns string 'step changed')`,
        // listCurrentWorkflowSteps: `(lists all steps in the current workflow): ->(returns array of step names)`,
        // getStepDetails: `(gets step details and instructions by name): !name<string>(name of the step)->(returns step instructions and details)`,
        cancelTask: `(cancels the current task): ->(returns string 'task cancelled')`,
        setState: `(sets a value for a given key in the task state): !key<string>(key to set), !value<any>(value to set)->(returns string 'context updated')`,
        submit: `(submits current step): <any>(JSON object to be stored in task context for future references)->(returns step submission results)`,
    };

    Object.keys(actionModules).filter(Boolean).forEach((actionName) => {
        actionModules[actionName].spec = actionSpecs[actionName];
    });

    if (taskDoc) {
        workflow = await models.workflows.findOne({ _id: taskDoc.workflow }, { populate: ['steps'] });
        currentStep = await models.steps.findOne({ _id: taskDoc.currentStep }, { populate: ['actions'] });
        currentStep.onSubmit = currentStep?.onSubmit ? await models.actions.findOne({ _id: currentStep.onSubmit }) : null;
        if (currentStep?.job?._id && currentStep?.job?._id !== copilotz?.job?._id) {
            const job = await models.jobs.findOne({ _id: currentStep.job }, { populate: ['actions'] });
            copilotz.job = job;
        }

        // 2. Get current step details
        const {
            name: stepName,
            instructions: stepInstructions,
            submitWhen,
        } = currentStep;

        // Combine actions and ensure uniqueness by action ID
        const uniqueActionsMap = new Map();

        [
            ...(copilotz.actions || []),
            ...(copilotz?.job?.actions || []),
            ...(currentStep?.actions || []),
            (currentStep?.onSubmit || null),
        ]
            .filter(Boolean)
            .forEach(action => {
                uniqueActionsMap.set(action._id.toString(), action);
            });

        copilotz.actions = Array.from(uniqueActionsMap.values());
        resources.copilotz = copilotz;

        // 3. Create Instructions
        const taskManagerPrompt = createPrompt(currentTaskPromptTemplate, {
            workflow: workflow.name,
            workflowDescription: workflow.description,
            steps: workflow.steps.map((step) => step.name).join(', '),
            stepInstructions,
            stepName,
            context: JSON.stringify(taskDoc?.context?.state),
            submitWhen,
        });

        instructions = taskManagerPrompt + (instructions || '');
    } else {
        // No active task found
        // Assistant should decide whether to start a task based on user input
        // Provide the assistant with available workflows
        const availableWorkflowsPrompt = createPrompt(availableWorkflowsTemplate, {
            workflows: allWorkflows.filter(Boolean).map((wf) => `- ${wf.name}: ${wf.description}`).join('\n'),
        });

        instructions = availableWorkflowsPrompt + instructions;
    }

    if (!threadLogs || !threadLogs?.length) {
        threadLogs = await getThreadHistory(thread.extId, { functionName: 'taskManager', maxRetries: 10 })
    }

    const functionCallAgent = await withHooks(await agents('functionCall'));

    const functionCallAgentResponse = await functionCallAgent.bind(this)(
        {
            resources,
            actionModules,
            instructions,
            input,
            audio,
            user,
            thread,
            answer,
            options,
            threadLogs,
            agentType
        },
        res
    );

    let taskManagerAgentResponse = {};

    try {

        // Use the base output schema for validation
        taskManagerAgentResponse = validate(
            jsonSchemaToShortSchema(outputSchema),
            functionCallAgentResponse,
            {
                optional: false,
                path: '$',
                rejectExtraProperties: false,
            }
        );

    } catch (err) {
        console.error('[taskManager] Validation error:', err);
        taskManagerAgentResponse = {
            ...functionCallAgentResponse,
            error: { code: 'INVALID_RESPONSE', message: err.message || 'Invalid response format' },
        };
    }

    // if any function.name is any of actionModules
    if (
        Object.keys(actionModules)?.some((key) => taskManagerAgentResponse.functions?.some((func) => func.name === key && func.name !== 'callback')) &&
        iterations < maxIter
    ) {
        return await withHooks(taskManager).bind(this)(
            {
                input: '',
                actionModules,
                user,
                thread,
                threadLogs: [
                    ...threadLogs,
                    {
                        role: 'assistant',
                        content: JSON.stringify(validate(
                            jsonSchemaToShortSchema(outputSchema),
                            functionCallAgentResponse
                        ))
                    },
                ],
                options,
                agentType,
                iterations: iterations + 1,
                resources
            },
            res
        );
    }

    if (currentStep && !currentStep?.next) {
        models.tasks.update({ _id: taskDoc._id }, { status: 'completed' });
    }

    // Prepare the final response in consistent format
    const response = {
        ...taskManagerAgentResponse,
        consumption: {
            type: 'steps',
            value: iterations + 1,
        },
        input: input,
        __tags__: {
            threadId: thread.extId,
        }
    };

    return response;
};

export default taskManager;

const currentTaskPromptTemplate = `
{{copilotPrompt}}
================
{{functionCallsPrompt}}
================
{{responseFormatPrompt}}
================

## TASK CONTEXT

The current task context is:
<context>
{{context}}
</context>

## INSTRUCTIONS FOR CURRENT STEP

<currentStep>
{{stepName}}: {{stepInstructions}}
</currentStep>

Guidelines:
- Strictly follow the <currentStep></currentStep> instructions, prioritizing this section over others in this prompt.

### Submit Step Completion

Submit this step using the 'submit' function when:
<submitWhen>
{{submitWhen}}
</submitWhen>

### Example

Example message for submitting a step:
<exampleAssistantMessage>
message: "" // message to be displayed to the user when you are submitting the step. blank is fine.
functions: [
    {
        "name": "submit",
        "args": {"foo":"bar", ...}
    },
]
</exampleAssistantMessage>

Guidelines
- Submit as soon as the condition of \`submitWhen\` has been satisfied, unless instructed otherwise in other parts of this prompt.

================
{{currentDatePrompt}}
================
`;

const availableWorkflowsTemplate = `
{{copilotPrompt}}
================
{{functionCallsPrompt}}
================
{{responseFormatPrompt}}
================
## YOUR ASSIGNMENT:

Start a task from on of the following available workflows.

<workflows>
{{workflows}}
</workflows>

Guidelines:
- Workflows above are formatted in the form \`- [name]: [description]\`
- Start tasks as soon as you identify the user intent. This is important so you can get more instructions for how to complete the task.
- When starting a task, use the 'createTask' function with the appropriate workflowName and wait for further instructions from the system.

================
{{currentDatePrompt}}
================
`;

const _baseOutputSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
        message: {
            type: 'string',
            description: 'Message for the user',
        },
        functions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Function name',
                    },
                    args: {
                        type: 'object',
                        description: '{...args, [arg_name]: arg_value}',
                    },
                    results: {
                        type: 'any',
                        description: 'To be filled with function result',
                    },
                    status: {
                        type: 'string',
                        description: 'Function status',
                    },
                },
                required: ['name'],
            },
            description: 'List of functions',
        },
    },
    required: ['message', 'functions'],
};



