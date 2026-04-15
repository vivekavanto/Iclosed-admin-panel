# Proposed Jest Tests for iClosed Admin Panel

This document outlines the recommended Jest tests for the iClosed Admin Panel. Each test is labeled as either **TDD** (Test-Driven Development) or **BDD** (Behavior-Driven Development).

---

## Table of Contents

1. [Business Logic Tests](#business-logic-tests)
2. [API Route Tests](#api-route-tests)
3. [Service Tests](#service-tests)
4. [Component Tests](#component-tests)
5. [Integration Tests](#integration-tests)

---

## Business Logic Tests

### `src/lib/convertLead.ts`

#### TDD - File Number Generation

```typescript
describe('generateFileNumber', () => {
  it('should generate file number with correct prefix for Purchase deals')
  it('should generate file number with correct prefix for Sale deals')
  it('should generate file number with correct prefix for Refinance deals')
  it('should pad file number to correct length')
  it('should increment from the last file number in database')
  it('should handle case when no previous file numbers exist')
  it('should throw error on duplicate file number collision')
})
```

#### TDD - Client Creation/Lookup

```typescript
describe('createOrFindClient', () => {
  it('should return existing client when email matches')
  it('should create new client when email does not exist')
  it('should normalize email to lowercase before lookup')
  it('should populate all required client fields on creation')
  it('should handle database errors gracefully')
})
```

#### BDD - Single Lead Conversion

```typescript
describe('convertLead - single lead', () => {
  describe('Given a valid lead with complete information', () => {
    describe('When the lead is converted to a deal', () => {
      it('should create a new deal with correct type and status')
      it('should associate the deal with the correct client')
      it('should copy task templates to deal tasks')
      it('should copy stage templates to deal milestones')
      it('should update lead status to "Converted"')
      it('should return success with the new deal ID')
    })
  })

  describe('Given a lead that has already been converted', () => {
    describe('When attempting to convert again', () => {
      it('should return error indicating lead already converted')
      it('should not create duplicate deals')
    })
  })
})
```

#### BDD - Family (Co-Purchaser) Lead Conversion

```typescript
describe('convertLead - family conversion', () => {
  describe('Given multiple leads with matching property addresses', () => {
    describe('When converting as a family group', () => {
      it('should create deals for all family members')
      it('should link all deals via parent_lead_id')
      it('should designate one deal as primary')
      it('should create shared tasks only on primary deal')
      it('should sync shared task references to co-purchaser deals')
      it('should send auth invite emails to all family members')
    })
  })

  describe('Given a family with one lead already converted', () => {
    describe('When converting remaining family members', () => {
      it('should only convert unconverted leads')
      it('should link new deals to existing family group')
    })
  })
})
```

#### TDD - Auth Email Invite

```typescript
describe('sendAuthInvite', () => {
  it('should generate Supabase invite link without sending default email')
  it('should fetch custom email template from database')
  it('should interpolate placeholders in template')
  it('should send email via Resend API')
  it('should fall back to default template when custom not found')
  it('should handle Resend API failures gracefully')
})
```

---

### `src/lib/recalcMilestones.ts`

#### TDD - Milestone Status Calculation

```typescript
describe('calculateMilestoneStatus', () => {
  it('should return "Completed" when all tasks are completed')
  it('should return "In Progress" when any task is in progress')
  it('should return "Pending" when all tasks are pending')
  it('should return "Pending" when milestone has no tasks')
  it('should correctly aggregate shared and personal tasks')
})
```

#### BDD - Milestone Recalculation Workflow

```typescript
describe('recalcMilestones', () => {
  describe('Given a deal with multiple milestones and tasks', () => {
    describe('When a task is marked as completed', () => {
      it('should update milestone status if all tasks completed')
      it('should not change milestone status if other tasks remain')
    })

    describe('When milestone transitions to Completed', () => {
      it('should trigger milestone completion email')
      it('should mark emailSent flag as true')
      it('should not send duplicate emails on subsequent recalcs')
    })
  })

  describe('Given a family deal with shared tasks', () => {
    describe('When recalculating milestones', () => {
      it('should include shared task status from primary deal')
      it('should sync milestone status across all family deals')
    })
  })
})
```

---

### `src/lib/completeApsTask.ts`

#### TDD - APS Task Identification

```typescript
describe('findApsTaskTemplate', () => {
  it('should find task template with is_aps_task flag set to true')
  it('should return null when no APS task template exists')
  it('should filter by deal type when specified')
})
```

#### BDD - APS Upload Completion

```typescript
describe('completeApsTask', () => {
  describe('Given a deal with an APS task pending', () => {
    describe('When APS document is uploaded', () => {
      it('should mark APS task as completed')
      it('should set completedAt timestamp')
      it('should trigger milestone recalculation')
    })
  })

  describe('Given a family deal with shared APS task', () => {
    describe('When APS is uploaded on primary deal', () => {
      it('should complete APS task on primary deal')
      it('should sync completion status to co-purchaser deals')
      it('should recalculate milestones for all family deals')
    })
  })

  describe('Given an APS task that is already completed', () => {
    describe('When completeApsTask is called again', () => {
      it('should be idempotent and not throw errors')
      it('should not update completedAt timestamp')
    })
  })
})
```

---

### `src/lib/familyDeals.ts`

#### TDD - Family Resolution

```typescript
describe('getFamilyDealIds', () => {
  it('should return single deal ID for standalone deals')
  it('should return all deal IDs for family with parent_lead_id')
  it('should include primary deal in family results')
  it('should handle deals with no associated lead')
  it('should return empty array for invalid deal ID')
})
```

#### BDD - Co-Purchaser Detection

```typescript
describe('Family deal detection', () => {
  describe('Given leads with matching property addresses', () => {
    describe('When querying family relationships', () => {
      it('should identify all leads as part of same family')
      it('should correctly identify the primary lead')
    })
  })
})
```

---

### `src/lib/sendAuthEmail.ts`

#### TDD - Template Placeholder Interpolation

```typescript
describe('interpolatePlaceholders', () => {
  it('should replace {{ user.first_name }} with actual first name')
  it('should replace {{ user.last_name }} with actual last name')
  it('should replace {{ confirmation_url }} with auth link')
  it('should handle missing placeholder values gracefully')
  it('should preserve HTML structure in template')
})
```

#### BDD - Auth Email Delivery

```typescript
describe('sendAuthEmail', () => {
  describe('Given a new client needing an invite', () => {
    describe('When sendInviteEmail is called', () => {
      it('should generate valid Supabase auth link')
      it('should send personalized email via Resend')
      it('should use custom template from database')
    })
  })

  describe('Given a client requesting password reset', () => {
    describe('When sendPasswordResetEmail is called', () => {
      it('should generate recovery link')
      it('should send reset email to client')
      it('should use password reset template')
    })
  })

  describe('Given Resend API is unavailable', () => {
    describe('When attempting to send email', () => {
      it('should throw descriptive error')
      it('should not leave auth state inconsistent')
    })
  })
})
```

---

## API Route Tests

### `src/app/api/admin/deals/route.ts`

#### TDD - Deal List Query

```typescript
describe('GET /api/admin/deals', () => {
  it('should return all deals with task counts')
  it('should include co-purchaser information for family deals')
  it('should order deals by creation date descending')
  it('should handle empty deals table')
  it('should return 500 on database error')
})
```

#### BDD - Deal Retrieval

```typescript
describe('Deals API', () => {
  describe('Given an admin user requesting deal list', () => {
    describe('When GET /api/admin/deals is called', () => {
      it('should return deals with progress percentages')
      it('should include linked family deals')
      it('should return proper JSON structure')
    })
  })
})
```

---

### `src/app/api/admin/convert-lead/route.ts`

#### BDD - Lead Conversion API

```typescript
describe('POST /api/admin/convert-lead', () => {
  describe('Given valid lead ID in request body', () => {
    describe('When conversion is requested', () => {
      it('should convert lead to deal')
      it('should return new deal ID and file number')
      it('should return 201 status on success')
    })
  })

  describe('Given request to convert family', () => {
    describe('When convertFamily flag is true', () => {
      it('should convert all family members')
      it('should return array of conversion results')
    })
  })

  describe('Given invalid lead ID', () => {
    describe('When conversion is requested', () => {
      it('should return 404 with error message')
    })
  })
})
```

---

### `src/app/api/admin/tasks/route.ts`

#### TDD - Task Queries

```typescript
describe('GET /api/admin/tasks', () => {
  it('should return tasks filtered by deal_id')
  it('should include shared tasks from primary deal for co-purchasers')
  it('should return personal tasks specific to the deal')
  it('should return 400 when deal_id is missing')
})
```

#### TDD - Task Status Update

```typescript
describe('PATCH /api/admin/tasks', () => {
  it('should update task status')
  it('should trigger milestone recalculation')
  it('should sync shared task updates to family deals')
  it('should return updated task object')
  it('should return 404 for non-existent task')
})
```

---

### `src/app/api/admin/milestones/route.ts`

#### BDD - Milestone Updates

```typescript
describe('PATCH /api/admin/milestones', () => {
  describe('Given a milestone update request', () => {
    describe('When updating milestone on a family deal', () => {
      it('should sync milestone status across all family deals')
      it('should trigger completion email if status becomes Completed')
    })
  })
})
```

---

### `src/app/api/admin/send-milestone-email/route.ts`

#### TDD - Milestone Email Sending

```typescript
describe('POST /api/admin/send-milestone-email', () => {
  it('should fetch email template by milestone.emailTemplateId')
  it('should interpolate deal and client placeholders')
  it('should send email via Resend')
  it('should return 200 on success')
  it('should return 404 when template not found')
  it('should return 500 on Resend API failure')
})
```

---

### `src/app/api/admin/email-templates/route.ts`

#### TDD - Email Template CRUD

```typescript
describe('Email Templates API', () => {
  describe('GET /api/admin/email-templates', () => {
    it('should return all email templates')
    it('should include subject, body, and metadata')
  })

  describe('POST /api/admin/email-templates', () => {
    it('should create new email template')
    it('should validate required fields')
    it('should return 400 for invalid payload')
  })

  describe('PUT /api/admin/email-templates', () => {
    it('should update existing template')
    it('should return 404 for non-existent template')
  })
})
```

---

### `src/app/api/admin/leads/route.ts`

#### BDD - Lead Listing with Auto-Linking

```typescript
describe('GET /api/admin/leads', () => {
  describe('Given leads with matching property addresses', () => {
    describe('When listing leads', () => {
      it('should auto-link leads as potential co-purchasers')
      it('should indicate linked leads in response')
    })
  })

  describe('Given no matching addresses', () => {
    describe('When listing leads', () => {
      it('should return leads without linking')
    })
  })
})
```

---

## Service Tests

### `src/services/geminiService.ts`

#### TDD - AI Email Generation

```typescript
describe('generateClientEmail', () => {
  it('should construct prompt with deal context')
  it('should call Google Generative AI API')
  it('should return generated email text')
  it('should handle API rate limiting')
  it('should throw error when API key is missing')
})
```

#### BDD - Email Generation Workflow

```typescript
describe('AI Email Generation', () => {
  describe('Given a deal requiring client communication', () => {
    describe('When generateClientEmail is called', () => {
      it('should produce contextually relevant email')
      it('should include client name in greeting')
      it('should reference deal-specific details')
    })
  })

  describe('Given Gemini API is unavailable', () => {
    describe('When generation is attempted', () => {
      it('should return error message to user')
      it('should not crash the application')
    })
  })
})
```

---

## Component Tests

### `src/components/Dashboard.tsx`

#### BDD - Dashboard Display

```typescript
describe('Dashboard Component', () => {
  describe('Given an admin viewing the dashboard', () => {
    describe('When the dashboard loads', () => {
      it('should display total active deals count')
      it('should display total pending deals count')
      it('should display total closed deals count')
      it('should render recent activity timeline')
      it('should render deal status chart')
    })
  })

  describe('Given no deals exist', () => {
    describe('When viewing dashboard', () => {
      it('should display zero counts')
      it('should show empty state for recent activity')
    })
  })
})
```

---

### `src/components/DealDetail.tsx`

#### BDD - Deal Detail View

```typescript
describe('DealDetail Component', () => {
  describe('Given a deal with tasks and milestones', () => {
    describe('When viewing deal details', () => {
      it('should display deal file number and status')
      it('should list all tasks grouped by milestone')
      it('should show progress percentage')
      it('should display client information')
    })

    describe('When marking a task as complete', () => {
      it('should update task status in UI')
      it('should trigger API call to update task')
      it('should recalculate progress')
    })
  })

  describe('Given a family deal', () => {
    describe('When viewing deal details', () => {
      it('should show co-purchaser section')
      it('should indicate shared vs personal tasks')
    })
  })
})
```

---

### `src/components/Leads.tsx`

#### BDD - Lead Management

```typescript
describe('Leads Component', () => {
  describe('Given a list of unconverted leads', () => {
    describe('When viewing leads page', () => {
      it('should display leads in a table')
      it('should show lead status badges')
      it('should enable filtering by status')
    })

    describe('When clicking Convert button on a lead', () => {
      it('should open conversion dialog')
      it('should offer family conversion option for linked leads')
    })
  })

  describe('Given address-matched leads', () => {
    describe('When viewing lead list', () => {
      it('should visually indicate linked leads')
      it('should group potential co-purchasers together')
    })
  })
})
```

---

### `src/components/Intake.tsx`

#### TDD - Form Validation

```typescript
describe('Intake Form Validation', () => {
  it('should require first name')
  it('should require last name')
  it('should validate email format')
  it('should validate phone number format')
  it('should require property address')
  it('should require deal type selection')
  it('should display validation errors inline')
})
```

#### BDD - Lead Intake Workflow

```typescript
describe('Intake Component', () => {
  describe('Given an admin entering new lead information', () => {
    describe('When submitting valid intake form', () => {
      it('should create new lead in database')
      it('should display success message')
      it('should clear form for next entry')
    })

    describe('When submitting with missing required fields', () => {
      it('should prevent submission')
      it('should highlight missing fields')
    })
  })
})
```

---

### `src/components/TaskTemplates.tsx`

#### BDD - Task Template Management

```typescript
describe('TaskTemplates Component', () => {
  describe('Given existing task templates', () => {
    describe('When viewing templates page', () => {
      it('should list all task templates')
      it('should show associated deal types')
      it('should show milestone assignments')
    })

    describe('When creating new template', () => {
      it('should open creation modal')
      it('should save template on submit')
      it('should update list with new template')
    })

    describe('When editing existing template', () => {
      it('should populate form with current values')
      it('should save changes on submit')
    })
  })
})
```

---

### `src/components/EmailTemplates.tsx`

#### BDD - Email Template Editor

```typescript
describe('EmailTemplates Component', () => {
  describe('Given an admin editing email templates', () => {
    describe('When selecting a template', () => {
      it('should load template content in editor')
      it('should show available placeholders')
      it('should enable preview mode')
    })

    describe('When saving template changes', () => {
      it('should persist changes to database')
      it('should show success notification')
    })

    describe('When previewing template', () => {
      it('should render HTML content')
      it('should show placeholder substitutions')
    })
  })
})
```

---

### `src/components/SearchDrawer.tsx`

#### BDD - Global Search

```typescript
describe('SearchDrawer Component', () => {
  describe('Given search drawer is open', () => {
    describe('When typing search query', () => {
      it('should debounce search input')
      it('should search across deals and leads')
      it('should display matching results')
    })

    describe('When clicking a search result', () => {
      it('should navigate to the relevant page')
      it('should close the search drawer')
    })

    describe('When no results match query', () => {
      it('should display no results message')
    })
  })
})
```

---

## Integration Tests

### Lead to Deal Conversion Flow

#### BDD - End-to-End Conversion

```typescript
describe('Lead to Deal Conversion - Integration', () => {
  describe('Given a new lead is created via intake', () => {
    describe('When the full conversion workflow is executed', () => {
      it('should create lead from intake form')
      it('should convert lead to deal with file number')
      it('should create client record')
      it('should copy task templates to deal')
      it('should copy milestone templates to deal')
      it('should send auth invite email')
      it('should mark lead as converted')
    })
  })
})
```

---

### Family Deal Workflow

#### BDD - Co-Purchaser Integration

```typescript
describe('Family Deal Management - Integration', () => {
  describe('Given two leads with same property address', () => {
    describe('When converting as family', () => {
      it('should link both deals together')
      it('should create shared tasks on primary deal')
      it('should allow task completion to sync across family')
      it('should recalculate milestones for all family members')
    })
  })
})
```

---

### Milestone Completion Email Flow

#### BDD - Automated Email Trigger

```typescript
describe('Milestone Completion Email - Integration', () => {
  describe('Given a deal with milestone near completion', () => {
    describe('When final task is marked complete', () => {
      it('should recalculate milestone status to Completed')
      it('should fetch associated email template')
      it('should send completion email to client')
      it('should mark emailSent flag on milestone')
    })
  })
})
```

---

## Test Setup Requirements

### Dependencies to Install

```bash
npm install -D jest @types/jest ts-jest jest-environment-jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  msw
```

### Mocking Strategy

| Dependency | Mock Approach |
|------------|---------------|
| Supabase Client | Mock `createClient` and `createServerClient` |
| Supabase Admin | Mock service role client |
| Resend API | Mock `Resend` class and `send` method |
| Google Generative AI | Mock `GoogleGenerativeAI` class |
| Next.js Router | Use `next-router-mock` |

### Test File Structure

```
src/
  __tests__/
    lib/
      convertLead.test.ts
      recalcMilestones.test.ts
      completeApsTask.test.ts
      familyDeals.test.ts
      sendAuthEmail.test.ts
    api/
      deals.test.ts
      tasks.test.ts
      leads.test.ts
      convert-lead.test.ts
      email-templates.test.ts
      milestones.test.ts
    services/
      geminiService.test.ts
    components/
      Dashboard.test.tsx
      DealDetail.test.tsx
      Leads.test.tsx
      Intake.test.tsx
      TaskTemplates.test.tsx
      EmailTemplates.test.tsx
      SearchDrawer.test.tsx
    integration/
      leadConversion.test.ts
      familyDeals.test.ts
      milestoneEmails.test.ts
```

---

## Summary

| Category | TDD Tests | BDD Tests |
|----------|-----------|-----------|
| Business Logic | 25 | 22 |
| API Routes | 18 | 12 |
| Services | 5 | 4 |
| Components | 6 | 28 |
| Integration | 0 | 9 |
| **Total** | **54** | **75** |

**Total Proposed Tests: 129**
