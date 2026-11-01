export interface Page {
  id: string;
  title: string;
  icon: string;
  parentId: string | null;
  order: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Account {
  email: string;
  name: string;
  picture?: string;
}
