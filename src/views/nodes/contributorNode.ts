'use strict';
import { TreeItem, TreeItemCollapsibleState, window } from 'vscode';
import { CommitNode } from './commitNode';
import { LoadMoreNode, MessageNode } from './common';
import { GlyphChars } from '../../constants';
import { Container } from '../../container';
import { ContributorsView } from '../contributorsView';
import { GitContributor, GitLog } from '../../git/git';
import { GitUri } from '../../git/gitUri';
import { insertDateMarkers } from './helpers';
import { RepositoriesView } from '../repositoriesView';
import { RepositoryNode } from './repositoryNode';
import { debug, gate, Iterables, Strings } from '../../system';
import { ContextValues, PageableViewNode, ViewNode } from './viewNode';
import { ContactPresence } from '../../vsls/vsls';

export class ContributorNode extends ViewNode<ContributorsView | RepositoriesView> implements PageableViewNode {
	static key = ':contributor';
	static getId(repoPath: string, name: string, email: string): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${name}|${email})`;
	}

	constructor(
		uri: GitUri,
		view: ContributorsView | RepositoriesView,
		parent: ViewNode,
		public readonly contributor: GitContributor,
		private readonly _options?: {
			all?: boolean;
			ref?: string;
			presence: Map<string, ContactPresence> | undefined;
		},
	) {
		super(uri, view, parent);
	}

	toClipboard(): string {
		return `${this.contributor.name}${this.contributor.email ? ` <${this.contributor.email}>` : ''}`;
	}

	get id(): string {
		return ContributorNode.getId(this.contributor.repoPath, this.contributor.name, this.contributor.email);
	}

	async getChildren(): Promise<ViewNode[]> {
		const log = await this.getLog();
		if (log == null) return [new MessageNode(this.view, this, 'No commits could be found.')];

		const getBranchAndTagTips = await Container.git.getBranchesAndTagsTipsFn(this.uri.repoPath);
		const children = [
			...insertDateMarkers(
				Iterables.map(
					log.commits.values(),
					c => new CommitNode(this.view, this, c, undefined, undefined, getBranchAndTagTips),
				),
				this,
			),
		];

		if (log.hasMore) {
			children.push(new LoadMoreNode(this.view, this, children[children.length - 1]));
		}
		return children;
	}

	async getTreeItem(): Promise<TreeItem> {
		const presence = this._options?.presence?.get(this.contributor.email);

		const item = new TreeItem(
			this.contributor.current ? `${this.contributor.name} (you)` : this.contributor.name,
			TreeItemCollapsibleState.Collapsed,
		);
		item.id = this.id;
		item.contextValue = this.contributor.current
			? `${ContextValues.Contributor}+current`
			: ContextValues.Contributor;
		item.description = `${
			presence != null && presence.status !== 'offline'
				? `${presence.statusText} ${GlyphChars.Space}${GlyphChars.Dot}${GlyphChars.Space} `
				: ''
		}${this.contributor.email}`;
		item.tooltip = `${this.contributor.name}${presence != null ? ` (${presence.statusText})` : ''}\n${
			this.contributor.email
		}\n${Strings.pluralize(
			'commit',
			this.contributor.count,
		)}\nLast commit ${this.contributor.formatDateFromNow()} (${this.contributor.formatDate()})`;

		if (this.view.config.avatars) {
			item.iconPath = await this.contributor.getAvatarUri({
				defaultStyle: Container.config.defaultGravatarsStyle,
			});
		}

		return item;
	}

	@gate()
	@debug()
	refresh(reset?: boolean) {
		if (reset) {
			this._log = undefined;
		}
	}

	private _log: GitLog | undefined;
	private async getLog() {
		if (this._log == null) {
			this._log = await Container.git.getLog(this.uri.repoPath!, {
				all: this._options?.all,
				ref: this._options?.ref,
				limit: this.limit ?? this.view.config.defaultItemLimit,
				authors: [`^${this.contributor.name} <${this.contributor.email}>$`],
			});
		}

		return this._log;
	}

	get hasMore() {
		return this._log?.hasMore ?? true;
	}

	limit: number | undefined = this.view.getNodeLastKnownLimit(this);
	@gate()
	async loadMore(limit?: number | { until?: any }) {
		let log = await window.withProgress(
			{
				location: { viewId: this.view.id },
			},
			() => this.getLog(),
		);
		if (log == null || !log.hasMore) return;

		log = await log.more?.(limit ?? this.view.config.pageItemLimit);
		if (this._log === log) return;

		this._log = log;
		this.limit = log?.count;

		void this.triggerChange(false);
	}
}
