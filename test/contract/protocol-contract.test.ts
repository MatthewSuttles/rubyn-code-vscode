import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as fs from 'fs';
import * as path from 'path';

const schemaPath = path.resolve(__dirname, '../../protocol/schema.json');
const fixturesDir = path.resolve(__dirname, '../../protocol/fixtures');

const schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

// Pre-compile the full schema so $ref resolution works
ajv.addSchema(schemaJson, 'protocol');

function loadFixtures(): { name: string; data: any }[] {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => ({
    name: f.replace(/\.json$/, ''),
    data: JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf-8')),
  }));
}

describe('IDE Protocol Contract', () => {
  describe('schema validity', () => {
    it('loads without errors', () => {
      expect(schemaJson).toBeDefined();
      expect(schemaJson.$defs).toBeDefined();
      expect(typeof schemaJson.$defs).toBe('object');
    });

    it('contains all expected method definitions', () => {
      const defs = schemaJson.$defs;

      // Client -> Server requests
      const requestDefs = [
        'initialize_params', 'initialize_result',
        'prompt_params', 'prompt_result',
        'cancel_params', 'cancel_result',
        'review_params', 'review_result',
        'approve_tool_use_params', 'approve_tool_use_result',
        'accept_edit_params', 'accept_edit_result',
        'shutdown_result',
        'config_get_params', 'config_get_result',
        'config_set_params', 'config_set_result',
        'models_list_result',
        'session_reset_params', 'session_reset_result',
      ];
      for (const defName of requestDefs) {
        expect(defs).toHaveProperty(defName, expect.anything());
      }

      // Server -> Client notifications
      const notificationDefs = [
        'stream_text_params', 'agent_status_params',
        'tool_use_params', 'tool_result_params',
        'file_edit_params', 'file_create_params',
        'review_finding_params', 'session_cost_params',
        'config_changed_params',
      ];
      for (const defName of notificationDefs) {
        expect(defs).toHaveProperty(defName, expect.anything());
      }

      // IDE RPC (server -> client requests)
      const ideRpcDefs = [
        'ide_open_diff_params', 'ide_open_diff_result',
        'ide_read_selection_result',
        'ide_read_active_file_result',
        'ide_save_file_params', 'ide_save_file_result',
        'ide_navigate_to_params',
        'ide_get_open_tabs_result',
        'ide_get_diagnostics_params', 'ide_get_diagnostics_result',
        'ide_get_workspace_symbols_params', 'ide_get_workspace_symbols_result',
      ];
      for (const defName of ideRpcDefs) {
        expect(defs).toHaveProperty(defName, expect.anything());
      }

      // Session management
      const sessionDefs = [
        'session_list_params', 'session_list_result',
        'session_resume_params', 'session_resume_result',
        'session_fork_params', 'session_fork_result',
      ];
      for (const defName of sessionDefs) {
        expect(defs).toHaveProperty(defName, expect.anything());
      }
    });
  });

  describe('fixture validation', () => {
    const fixtures = loadFixtures();

    for (const fixture of fixtures) {
      describe(`fixture: ${fixture.name}`, () => {
        it('has valid structure', () => {
          expect(fixture.data).toHaveProperty('description');
          expect(fixture.data).toHaveProperty('steps');
          expect(Array.isArray(fixture.data.steps)).toBe(true);
          expect(fixture.data.steps.length).toBeGreaterThan(0);
        });

        it('all steps have valid direction and type', () => {
          for (const [idx, step] of fixture.data.steps.entries()) {
            expect(['client_to_server', 'server_to_client']).toContain(step.direction);
            expect(['request', 'response', 'notification']).toContain(step.type);
          }
        });

        it('all messages are valid JSON-RPC 2.0', () => {
          for (const [idx, step] of fixture.data.steps.entries()) {
            const msg = step.message;
            expect(msg.jsonrpc).toBe('2.0');

            switch (step.type) {
              case 'request':
                expect(msg).toHaveProperty('id');
                expect(msg).toHaveProperty('method');
                break;
              case 'response':
                expect(msg).toHaveProperty('id');
                expect(
                  'result' in msg || 'error' in msg,
                ).toBe(true);
                break;
              case 'notification':
                expect(msg).toHaveProperty('method');
                expect(msg).not.toHaveProperty('id');
                break;
            }
          }
        });

        it('params and results validate against schema $defs', () => {
          for (const [idx, step] of fixture.data.steps.entries()) {
            if (step.validate_params) {
              const defName = step.validate_params;
              expect(schemaJson.$defs).toHaveProperty(defName);

              const validate = ajv.compile({
                $ref: `protocol#/$defs/${defName}`,
              });
              const params = step.message.params || {};
              const valid = validate(params);
              expect(valid, `Step ${idx}: params failed ${defName} validation: ${JSON.stringify(validate.errors)}`).toBe(true);
            }

            if (step.validate_result) {
              const defName = step.validate_result;
              expect(schemaJson.$defs).toHaveProperty(defName);

              const validate = ajv.compile({
                $ref: `protocol#/$defs/${defName}`,
              });
              const result = step.message.result;
              const valid = validate(result);
              expect(valid, `Step ${idx}: result failed ${defName} validation: ${JSON.stringify(validate.errors)}`).toBe(true);
            }
          }
        });
      });
    }
  });
});
