'use client';
import { AccountReports } from '@/components/account-reports';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
export default function ReportsPage() {
  const locale = useAdminLocale();
  return (
    <AdminGate allowed={(can) => can.has('admin:revenue-share:read')}>
      <AccountReports locale={locale} base="/admin/reports" scope="platform" />
    </AdminGate>
  );
}
