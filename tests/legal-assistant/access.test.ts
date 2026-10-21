import test from 'node:test';
import assert from 'node:assert/strict';
import type {User} from '@supabase/supabase-js';
import {canAccessOperations} from '../../src/lib/orchestrator/access.ts';
const user=(role:string,email='clerk@navawilson.law')=>({app_metadata:{role},email,email_confirmed_at:'2026-10-21T00:00:00Z'}as User);
test('Legal Assistant inherits dev admin access without admitting customers or granting admin rights from an email domain',()=>{assert.equal(canAccessOperations(user('admin')),true);assert.equal(canAccessOperations(user('inactive')),false);assert.equal(canAccessOperations(user('customer')),false);assert.equal(canAccessOperations(user('')),false);assert.equal(canAccessOperations(null),false);});
