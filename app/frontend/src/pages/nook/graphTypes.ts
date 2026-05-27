export type GraphNode = {
	id: string;
	label: string;
	noteType?: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
};

export type GraphEdge = {
	id: string;
	source: string;
	target: string;
	label: string;
};

export type GraphData = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};
