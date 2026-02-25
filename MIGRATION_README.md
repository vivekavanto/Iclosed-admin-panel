# iClosed Admin Portal - Next.js

React → Next.js migration of the iClosed admin portal with 100% UI/UX parity.

## Tech Stack

- **Framework**: Next.js 16.1.6 (App Router)
- **Styling**: Tailwind CSS v4 + DaisyUI v3
- **UI Components**: Lucide React
- **Data Visualization**: Recharts
- **AI Integration**: Google Generative AI (Gemini)
- **Language**: TypeScript

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout with Sidebar + SearchDrawer
│   ├── page.tsx                # Home (Dashboard)
│   ├── dashboard/page.tsx       # Dashboard view
│   ├── deals/page.tsx           # Deals list
│   ├── deals/[id]/page.tsx      # Deal detail
│   ├── intake/page.tsx          # Intake form
│   ├── leads/page.tsx           # Leads management
│   ├── tasks/page.tsx           # Tasks & compliance
│   ├── templates/page.tsx       # Workflow templates
│   ├── globals.css              # Tailwind + custom styles
│   ├── providers.tsx            # Navigation context
│   └── ClientLayout.tsx         # Client-side layout wrapper
├── components/
│   ├── Dashboard.tsx
│   ├── DealList.tsx
│   ├── DealDetail.tsx
│   ├── Sidebar.tsx
│   ├── SearchDrawer.tsx
│   ├── Leads.tsx
│   ├── Intake.tsx
│   ├── Templates.tsx
│   └── Tasks.tsx
├── services/
│   └── geminiService.ts         # Google Gemini AI integration
├── types.ts                      # Shared TypeScript types
└── constants.ts                  # Mock data & configuration
```

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
cd iclosed-admin-portal-next
npm install
```

### Environment Variables

Create `.env.local` in the root of `iclosed-admin-portal-next/`:

```env
API_KEY=your_google_genai_api_key_here
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

```bash
npm run build
npm start
```

## Features

- ✅ **Dashboard**: Overview of active deals, recent activity, and statistics
- ✅ **Deal Management**: Browse, search, and manage legal file transactions
- ✅ **Intake Forms**: Multi-step client onboarding process
- ✅ **Leads CRM**: Manage prospective client leads
- ✅ **Task Templates**: Workflow stages and task management
- ✅ **Search**: Global deal/client search with file number shortcut
- ✅ **Responsive UI**: Mobile-first Tailwind CSS design

## Migration Notes

- Components use `"use client"` directive for client-side interactivity
- Mock data from `constants.ts` (replace with API calls in production)
- Navigation state managed via React Context (providers.tsx)
- Service layer includes Gemini AI for email generation

## Next Steps

- [ ] Connect real backend API endpoints
- [ ] Implement authentication (NextAuth.js recommended)
- [ ] Add API routes for data fetching
- [ ] Deploy to Vercel or hosting provider
- [ ] Set up CI/CD pipeline

## Support

For issues or questions about the migration, refer to the original React components in the parent directory.
