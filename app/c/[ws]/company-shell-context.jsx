'use client';

import { createContext, useContext } from 'react';

const CompanyShellContext = createContext(null);

export function CompanyShellProvider({ value, children }) {
  return <CompanyShellContext.Provider value={value}>{children}</CompanyShellContext.Provider>;
}

export function useCompanyShell() {
  return useContext(CompanyShellContext);
}
