export const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the full contents of a project file. Path is relative to project root or absolute.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path e.g. lib/main.dart' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path within the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, use "." for project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for files by name within the project.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filename search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_content',
      description: 'Search for text content across project source files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_file_edit',
      description:
        'Propose an edit to a file. Provide the complete new file content. User must approve before changes are applied.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'Complete new file content' },
          description: { type: 'string', description: 'Brief description of the change' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'patch_file',
      description: 'Patch an existing file by replacing a specific block of text. This avoids overwriting the whole file. Fails if oldText is not found or occurs multiple times.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          oldText: { type: 'string', description: 'The exact block of text to be replaced. Must match exactly including whitespace and line endings.' },
          newText: { type: 'string', description: 'The new block of text to replace oldText.' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a shell/terminal command in the project root directory. Safe dev commands (flutter pub get, flutter analyze, npm install, etc.) run automatically. Destructive commands (rm -rf, git push --force, etc.) will require user confirmation. Returns stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact shell command line string to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a single file from the project. Requires user confirmation for irreversible deletion.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          reason: { type: 'string', description: 'Why this file is being deleted' },
        },
        required: ['path', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rename_file',
      description: 'Rename or move a file within the project workspace.',
      parameters: {
        type: 'object',
        properties: {
          oldPath: { type: 'string', description: 'Current file path relative to project root' },
          newPath: { type: 'string', description: 'New file path relative to project root' },
        },
        required: ['oldPath', 'newPath'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_design_manifest',
      description: 'Create or update the project Design Manifest (.peep/design.json). Use this to establish or evolve the project\'s visual DNA (colors, typography, spacing, component styles, brand personality). Always call this before generating major UI for the first time.',
      parameters: {
        type: 'object',
        properties: {
          manifest: {
            type: 'object',
            description: 'Full or partial DesignManifest object to merge into the existing manifest',
          },
        },
        required: ['manifest'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_plan',
      description: 'Manage the structured execution plan for the current task. Always initialize a plan at the start of a complex task. Use this tool to track progress.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['init', 'update_step', 'add_step', 'remove_step', 'retry_step'], description: 'The action to perform on the plan.' },
          goal: { type: 'string', description: 'Overall goal (required for init).' },
          complexity: { type: 'string', enum: ['simple', 'medium', 'complex'], description: 'Task complexity (required for init).' },
          steps: { 
            type: 'array', 
            items: { 
              type: 'object', 
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
                required: { type: 'boolean' },
                relevantFiles: { type: 'array', items: { type: 'string' } },
                impactRadius: { type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'description', 'status']
            },
            description: 'List of initial steps (required for init).'
          },
          acceptanceCriteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'verifying', 'verified', 'failed', 'not_verifiable'] },
                verificationMethod: { type: 'string', enum: ['test', 'typecheck', 'build', 'ui_structural', 'visual', 'manual'] },
                linkedStepIds: { type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'description', 'status', 'verificationMethod']
            },
            description: 'List of acceptance criteria derived from user request (required for init).'
          },
          stepId: { type: 'string', description: 'ID of the step to update or remove.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'New status for the step (for update_step).' },
          error: { type: 'string', description: 'Error description if step failed.' },
          step: { 
            type: 'object', 
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
              required: { type: 'boolean' },
              relevantFiles: { type: 'array', items: { type: 'string' } },
              impactRadius: { type: 'array', items: { type: 'string' } }
            },
            description: 'New step object (for add_step).'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'verify_criterion',
      description: 'Record a verification result for an Acceptance Criterion. You MUST use this tool to verify acceptance criteria after completing execution steps before claiming task completion.',
      parameters: {
        type: 'object',
        properties: {
          criterionId: { type: 'string', description: 'ID of the acceptance criterion being verified.' },
          status: { type: 'string', enum: ['verified', 'failed', 'not_verifiable'], description: 'The verification result.' },
          verificationMethod: { type: 'string', enum: ['test', 'typecheck', 'build', 'ui_structural', 'visual', 'manual'], description: 'The method used to verify.' },
          commandOrAction: { type: 'string', description: 'The command executed (e.g. pnpm test) or action taken.' },
          outputSummary: { type: 'string', description: 'Summary of the output or visual finding.' },
          evidence: { type: 'string', description: 'Any captured evidence (e.g. error trace or stdout snippet).' }
        },
        required: ['criterionId', 'status', 'verificationMethod', 'commandOrAction', 'outputSummary']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_memory',
      description: 'Manage persistent long-term project memory. Use this to remember stable architectural decisions, design rules, or project conventions. Do NOT store temporary debugging details or specific tool calls.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'add', 'update', 'remove'], description: 'Action to perform.' },
          category: { type: 'string', enum: ['architecture', 'conventions', 'design', 'preferences', 'decisions'], description: 'Category (for add).' },
          key: { type: 'string', description: 'Memory key or identifier (for add, update, remove).' },
          value: { type: 'string', description: 'Memory value (for add, update).' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'validate_project',
      description: 'Validate the project to verify compilation, lint rules, and types. Automatically runs tsc or flutter analyze based on framework. Call this to check if your code edits are correct.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'bootstrap_project',
      description: 'Initialize a new project in an empty folder. Scaffolds framework templates in-place.',
      parameters: {
        type: 'object',
        properties: {
          framework: { type: 'string', enum: ['react-native', 'flutter'], description: 'Framework choice' },
          environment: { type: 'string', enum: ['managed', 'local'], description: 'Environment type' },
          template: { type: 'string', description: 'Template identifier' }
        },
        required: ['framework', 'environment']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'install_dependencies',
      description: 'Install npm or pub packages automatically. Resolves packages in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of packages to install'
          }
        },
        required: ['packages']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'build_project',
      description: 'Build the application using the framework builder. Resolves platform output (e.g. apk, dist).',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['android', 'ios', 'web'], description: 'Platform target to build' }
        },
        required: ['platform']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_tests',
      description: 'Run the project test suite if configured. Automatically runs flutter test or npm run test.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'start_app',
      description: 'Start the application preview in the background. Returns the process identifier and local preview url.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'stop_app',
      description: 'Stop the active application process started by Atomvs.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Process identifier to kill' }
        },
        required: ['processId']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_process_status',
      description: 'Get the status (running, crashed, stopped) and started metrics of an active process.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Process identifier to query' }
        },
        required: ['processId']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_runtime_logs',
      description: 'Fetch process logs (stdout/stderr) and check for errors or crash stacks.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Process identifier to fetch logs from' }
        },
        required: ['processId']
      }
    }
  }
];
