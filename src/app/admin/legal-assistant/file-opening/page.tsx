import {redirect} from 'next/navigation';
import {getStaff} from '@/lib/orchestrator/server-auth';
import FileOpening from '@/components/orchestrator/FileOpening';
export const dynamic='force-dynamic';
export default async function Page(){if(!await getStaff())redirect('/admin/login');return <FileOpening/>;}
