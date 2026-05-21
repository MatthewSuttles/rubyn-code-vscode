/**
 * Unit tests for RoutesParser. The parser is regex-driven; tests are
 * fixture-shaped — feed a `routes.rb` excerpt, assert the emitted
 * NamedRoute list contains the expected entries.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../../helpers/mock-vscode';
import { RoutesParser, NamedRoute } from '../../../src/rails/RoutesParser';

function parser(extraFiles: Record<string, string> = {}): RoutesParser {
  return new RoutesParser({
    readFile: async (uri: vscode.Uri) => {
      const body = extraFiles[uri.fsPath];
      if (body === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
      return body;
    },
    routesDir: Uri.file('/app/config/routes'),
  });
}

function find(routes: NamedRoute[], helper: string, verb?: string): NamedRoute | undefined {
  return routes.find((r) => r.helper === helper && (!verb || r.verb === verb));
}

describe('RoutesParser — resources', () => {
  it('emits the 7 standard plural-resource routes', async () => {
    const routes = await parser().parse(`
      Rails.application.routes.draw do
        resources :users
      end
    `);
    expect(find(routes, 'users', 'GET')).toMatchObject({
      pattern: '/users',
      controller: 'users',
      action: 'index',
    });
    expect(find(routes, 'users', 'POST')).toMatchObject({
      action: 'create',
    });
    expect(find(routes, 'new_user', 'GET')).toMatchObject({
      pattern: '/users/new',
      action: 'new',
    });
    expect(find(routes, 'user', 'GET')).toMatchObject({
      pattern: '/users/:id',
      action: 'show',
    });
    expect(find(routes, 'edit_user', 'GET')).toMatchObject({
      pattern: '/users/:id/edit',
    });
    expect(find(routes, 'user', 'PATCH')).toMatchObject({ action: 'update' });
    expect(find(routes, 'user', 'DELETE')).toMatchObject({ action: 'destroy' });
  });

  it('honors only: filter', async () => {
    const routes = await parser().parse(`
      resources :users, only: [:index, :show]
    `);
    const helpers = routes.map((r) => `${r.helper}:${r.verb}`);
    expect(helpers).toContain('users:GET');
    expect(helpers).toContain('user:GET');
    expect(helpers.find((h) => h === 'user:DELETE')).toBeUndefined();
    expect(helpers.find((h) => h === 'edit_user:GET')).toBeUndefined();
  });

  it('honors except: filter', async () => {
    const routes = await parser().parse(`
      resources :users, except: [:destroy]
    `);
    expect(find(routes, 'user', 'DELETE')).toBeUndefined();
    expect(find(routes, 'user', 'GET')).toBeDefined();
  });

  it('emits the 6 singular-resource routes for resource :foo', async () => {
    const routes = await parser().parse(`
      resource :session
    `);
    expect(find(routes, 'new_session')).toMatchObject({ pattern: '/session/new' });
    expect(find(routes, 'session', 'GET')).toMatchObject({ pattern: '/session', action: 'show' });
    expect(find(routes, 'session', 'POST')).toMatchObject({ action: 'create' });
    expect(find(routes, 'session', 'DELETE')).toMatchObject({ action: 'destroy' });
    expect(find(routes, 'session', 'PATCH')).toMatchObject({ action: 'update' });
    expect(find(routes, 'edit_session')).toMatchObject({ pattern: '/session/edit' });
    // No index helper for singular resource.
    expect(routes.find((r) => r.action === 'index')).toBeUndefined();
  });
});

describe('RoutesParser — namespace and scope', () => {
  it('namespace prefixes both helper and path', async () => {
    const routes = await parser().parse(`
      namespace :admin do
        resources :users
      end
    `);
    expect(find(routes, 'admin_users', 'GET')).toMatchObject({
      pattern: '/admin/users',
      controller: 'admin/users',
    });
    expect(find(routes, 'edit_admin_user', 'GET')).toMatchObject({
      pattern: '/admin/users/:id/edit',
    });
  });

  it('scope path: prefixes path but not helper', async () => {
    const routes = await parser().parse(`
      scope path: "/v1" do
        resources :widgets
      end
    `);
    expect(find(routes, 'widgets', 'GET')).toMatchObject({
      pattern: '/v1/widgets',
      controller: 'widgets',
    });
  });

  it('scope module: prefixes controller path', async () => {
    const routes = await parser().parse(`
      scope module: "api" do
        resources :widgets
      end
    `);
    expect(find(routes, 'widgets', 'GET')!.controller).toBe('api/widgets');
  });

  it('combines scope path: and module:', async () => {
    const routes = await parser().parse(`
      scope path: "/v1", module: "api" do
        resources :widgets
      end
    `);
    const widget = find(routes, 'widgets', 'GET')!;
    expect(widget.pattern).toBe('/v1/widgets');
    expect(widget.controller).toBe('api/widgets');
  });
});

describe('RoutesParser — member / collection', () => {
  it('emits member routes with the action prefix', async () => {
    const routes = await parser().parse(`
      resources :users do
        member do
          get :follow
          delete :unfollow
        end
      end
    `);
    expect(find(routes, 'follow_user', 'GET')).toMatchObject({
      pattern: '/users/:id/follow',
      controller: 'users',
      action: 'follow',
    });
    expect(find(routes, 'unfollow_user', 'DELETE')).toMatchObject({
      pattern: '/users/:id/unfollow',
    });
  });

  it('emits collection routes with the action prefix and plural helper', async () => {
    const routes = await parser().parse(`
      resources :users do
        collection do
          get :search
        end
      end
    `);
    expect(find(routes, 'search_users', 'GET')).toMatchObject({
      pattern: '/users/search',
      controller: 'users',
      action: 'search',
    });
  });
});

describe('RoutesParser — HTTP verb routes', () => {
  it('parses get with to: and as:', async () => {
    const routes = await parser().parse(`
      get "/about", to: "pages#about", as: :about
    `);
    expect(find(routes, 'about', 'GET')).toMatchObject({
      pattern: '/about',
      controller: 'pages',
      action: 'about',
    });
  });

  it('respects namespace path/module for verb routes', async () => {
    const routes = await parser().parse(`
      namespace :admin do
        get "/health", to: "system#health", as: :health
      end
    `);
    expect(find(routes, 'admin_health')).toMatchObject({
      pattern: '/admin/health',
      controller: 'admin/system',
      action: 'health',
    });
  });
});

describe('RoutesParser — root', () => {
  it('parses root to: "controller#action"', async () => {
    const routes = await parser().parse(`
      root to: "pages#home"
    `);
    expect(find(routes, 'root')).toMatchObject({
      verb: 'GET',
      pattern: '/',
      controller: 'pages',
      action: 'home',
    });
  });
});

describe('RoutesParser — draw recursion', () => {
  it('reads draw target from config/routes/<name>.rb and merges its routes', async () => {
    const p = parser({
      '/app/config/routes/marketing.rb': 'resources :campaigns, only: [:index, :show]',
    });
    const routes = await p.parse(`
      draw :marketing
    `);
    expect(find(routes, 'campaigns', 'GET')).toMatchObject({
      pattern: '/campaigns',
      action: 'index',
    });
    expect(find(routes, 'campaign', 'GET')).toMatchObject({
      pattern: '/campaigns/:id',
      action: 'show',
    });
  });

  it('does not recurse infinitely if a draw cycle exists', async () => {
    const p = parser({
      '/app/config/routes/loop.rb': 'draw :loop',
    });
    const routes = await p.parse(`
      draw :loop
    `);
    expect(routes).toEqual([]);
  });
});

describe('RoutesParser — fixture parity', () => {
  it('parses the committed fixture routes.rb covering >= 10 patterns', async () => {
    // Read the fixture directly through Node fs to confirm the parser handles
    // it end-to-end. We pass marketing.rb in via the readFile dep too.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const routesRb = path.join(__dirname, '..', '..', 'fixtures', 'rails-app', 'config', 'routes.rb');
    const marketingRb = path.join(__dirname, '..', '..', 'fixtures', 'rails-app', 'config', 'routes', 'marketing.rb');
    const source = await fs.readFile(routesRb, 'utf-8');
    const drawn = await fs.readFile(marketingRb, 'utf-8');

    const p = new RoutesParser({
      readFile: async (uri: vscode.Uri) => {
        if (uri.fsPath.endsWith('marketing.rb')) return drawn;
        throw new Error(`ENOENT: ${uri.fsPath}`);
      },
      routesDir: Uri.file('/'),
    });
    const routes = await p.parse(source);
    expect(routes.length).toBeGreaterThanOrEqual(10);

    expect(find(routes, 'root')).toBeDefined();
    expect(find(routes, 'about')).toBeDefined();
    expect(find(routes, 'follow_user', 'GET')).toBeDefined();
    expect(find(routes, 'admin_users', 'GET')).toBeDefined();
    expect(find(routes, 'campaigns', 'GET')).toBeDefined();
    expect(find(routes, 'new_session', 'GET')).toBeDefined();
  });
});
