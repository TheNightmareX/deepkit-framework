/*
 * Deepkit Framework
 * Copyright (C) 2020 Deepkit UG
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * This is a collection object that contains items of an certain entity.
 * This collection "lives" in the sense that its items are automatically
 * updated, added and removed. When such a change happens, an event is triggered* you can listen on.
 */
import { ReplaySubject, Subject, TeardownLogic } from 'rxjs';
import { IdInterface } from './model';
import { tearDown } from '@deepkit/core-rxjs';
import { ClassType, each, getClassName, isArray } from '@deepkit/core';
import { EntitySubject } from './model';
import { ClassSchema, t } from '@deepkit/type';

export type FilterParameters = { [name: string]: any | undefined };

export type QuerySelector<T> = {
    // Comparison
    $eq?: T;
    $gt?: T;
    $gte?: T;
    $in?: T[];
    $lt?: T;
    $lte?: T;
    $ne?: T;
    $nin?: T[];
    // Logical
    $not?: T extends string ? (QuerySelector<T> | RegExp) : QuerySelector<T>;
    $regex?: T extends string ? (RegExp | string) : never;

    //special deepkit/type type
    $parameter?: string;
};

export type RootQuerySelector<T> = {
    $and?: Array<FilterQuery<T>>;
    $nor?: Array<FilterQuery<T>>;
    $or?: Array<FilterQuery<T>>;
    // we could not find a proper TypeScript generic to support nested queries e.g. 'user.friends.name'
    // this will mark all unrecognized properties as any (including nested queries)
    [key: string]: any;
};

type RegExpForString<T> = T extends string ? (RegExp | T) : T;
type MongoAltQuery<T> = T extends Array<infer U> ? (T | RegExpForString<U>) : RegExpForString<T>;
export type Condition<T> = MongoAltQuery<T> | QuerySelector<MongoAltQuery<T>>;

//should be in sync with @deepkit/orm
export type FilterQuery<T> = {
    [P in keyof T & string]?: Condition<T[P]>;
} &
    RootQuerySelector<T>;

//should be in sync with @deepkit/orm
export type SORT_ORDER = 'asc' | 'desc' | any;
export type Sort<T, ORDER extends SORT_ORDER = SORT_ORDER> = { [P in keyof T & string]?: ORDER };

export interface CollectionEventAdd<T> {
    type: 'add';
    items: T[];
}

export interface CollectionEventState {
    type: 'state';
    state: CollectionState;
}

export interface CollectionEventRemove {
    type: 'remove';
    ids: (string | number)[];
}

export interface CollectionEventSet {
    type: 'set';
    items: any[];
}

export type CollectionEvent<T> = CollectionEventAdd<T> | CollectionEventRemove | CollectionEventSet | CollectionEventState;

export type CollectionSortDirection = 'asc' | 'desc';

export interface CollectionSort {
    field: string;
    direction: CollectionSortDirection;
}

export interface CollectionEntitySubjectFetcher {
    fetch<T extends IdInterface>(classType: ClassType<T>, id: string | number): EntitySubject<T>;
}

/**
 * internal note: This is aligned with @deepit/orm `DatabaseQueryModel`
 */
export class CollectionQueryModel<T> {
    @t.map(t.any).optional
    filter?: FilterQuery<T>;

    @t.number.optional
    skip?: number;

    @t.number
    itemsPerPage: number = 50;

    @t.number.optional
    limit?: number;

    @t.map(t.any)
    parameters: { [name: string]: any } = {};

    @t.map(t.any).optional
    sort?: Sort<T>;

    public readonly change = new Subject<void>();

    changed(): void {
        this.change.next();
    }

    hasSort(): boolean {
        return this.sort !== undefined;
    }

    /**
     * Whether limit/skip is activated.
    */
    hasPaging(): boolean {
        return this.limit !== undefined || this.skip !== undefined;
    }
}

export class CollectionState {
    /**
     * Total count in the database for the current query, regardless of paging (skip/limit) count.
     * 
     * Use count() to get the items count on the current page (which is equal to all().length)
     */
    @t total: number = 0;
}

export class Collection<T extends IdInterface> extends ReplaySubject<T[]> {
    public readonly event: Subject<CollectionEvent<T>> = new Subject;

    public readonly removed = new Subject<T>();
    public readonly added = new Subject<T>();

    protected readonly teardowns: TeardownLogic[] = [];

    protected items: T[] = [];
    protected itemsMap = new Map<string | number, T>();

    public state: CollectionState = new CollectionState();

    public readonly deepChange = new Subject<T>();

    protected nextChange?: Promise<void>;
    protected nextChangeResolver?: () => void;

    // public readonly pagination: CollectionPagination<T> = new CollectionPagination(this);

    protected entitySubjectFetcher?: CollectionEntitySubjectFetcher;

    public model: CollectionQueryModel<T> = new CollectionQueryModel();

    public readonly entitySubjects = new Map<string | number, EntitySubject<T>>();

    constructor(
        public readonly classType: ClassType<T>,
    ) {
        super(1);
    }

    public getTotal() {
        return this.state.total;
    }

    public getItemsPerPage() {
        return this.model.itemsPerPage;
    }

    public getPages() {
        return Math.ceil(this.getTotal() / this.getItemsPerPage());
    }

    public getSort() {
        return this.model.sort;
    }

    public getParameter(name: string) {
        return this.model.parameters[name];
    }

    public setParameter(name: string, value: any): this {
        this.model.parameters[name] = value;
        return this;
    }

    public orderByField(name: keyof T & string, order: SORT_ORDER = 'asc') {
        this.model.sort = {[name]: order} as Sort<T>;
        return this;
    }

    public setPage(page: number) {
        this.model.skip = this.getItemsPerPage() * page;
        return this;
    }

    public getPage() {
        return Math.floor((this.model.skip || 0) / this.getItemsPerPage());
    }

    public apply() {
        this.model.changed();
        return this.nextStateChange;
    }

    public getEntitySubject(idOrItem: string | number | T): EntitySubject<T> | undefined {
        const id: any = idOrItem instanceof this.classType ? idOrItem.id : idOrItem;
        return this.entitySubjects.get(id);
    }

    public has(id: string | number) {
        return this.itemsMap.has(id);
    }

    public get(id: string | number): T | undefined {
        return this.itemsMap.get(id);
    }

    public setState(state: CollectionState) {
        this.state = state;
        this.event.next({ type: 'state', state });
    }

    /**
     * Resolves when next change happened.
     */
    get nextStateChange(): Promise<void> {
        if (!this.nextChange) {
            this.nextChange = new Promise((resolve) => {
                this.nextChangeResolver = resolve;
            });
        }
        return this.nextChange;
    }

    public unsubscribe() {
        super.unsubscribe();

        for (const teardown of this.teardowns) tearDown(teardown);

        for (const subject of this.entitySubjects.values()) {
            subject.unsubscribe();
        }

        this.teardowns.length = 0;
    }

    public addTeardown(teardown: TeardownLogic) {
        this.teardowns.push(teardown);
    }

    public index(item: T): number {
        return this.items.indexOf(item);
    }

    /**
     * Returns the page zero-based of the current item.
     */
    public getPageOf(item: T, itemsPerPage = 10): number {
        const index = this.index(item);

        if (-1 === index) return 0;

        return Math.floor(index / itemsPerPage);
    }

    public reset() {
        this.items = [];
        this.entitySubjects.clear();
        this.itemsMap.clear();
    }

    public all(): T[] {
        return this.items;
    }

    /**
     * Count of current page if paging is used, otherwise total count.
     */
    public count() {
        return this.items.length;
    }

    public ids(): (string | number)[] {
        const ids: (string | number)[] = [];
        for (const i of this.items) {
            ids.push(i.id);
        }

        return ids;
    }

    public empty() {
        return 0 === this.items.length;
    }

    /**
     * All items from id -> value map.
     */
    public map() {
        return this.itemsMap;
    }

    public loaded() {
        if (this.isStopped) {
            throw new Error('Collection already unsubscribed');
        }
        this.next(this.items);

        if (this.nextChangeResolver) {
            this.nextChangeResolver();
            this.nextChangeResolver = undefined;
            this.nextChange = undefined;
        }
    }

    public set(items: T[], withEvent = true) {
        for (const item of items) {
            if (!this.itemsMap.has(item.id)) {
                this.added.next(item);
            }
            this.itemsMap.delete(item.id);
        }

        //remaining items will be deleted
        for (const deleted of this.itemsMap.values()) {
            this.removed.next(deleted);
            const subject = this.entitySubjects.get(deleted.id);
            if (subject) {
                subject.unsubscribe();
                this.entitySubjects.delete(deleted.id);
            }
        }

        this.itemsMap.clear();
        this.items = items;

        for (const item of items) {
            this.itemsMap.set(item.id, item);
        }

        if (withEvent) {
            this.event.next({ type: 'set', items: items });
        }
    }

    public removeMany(ids: (string | number)[], withEvent = true) {
        for (const id of ids) {
            const item = this.itemsMap.get(id);
            this.itemsMap.delete(id);
            if (item) {
                const index = this.items.indexOf(item);
                if (-1 !== index) {
                    this.removed.next(this.items[index]);
                    this.items.splice(index, 1);
                }
            }
            const subject = this.entitySubjects.get(id);
            if (subject) {
                subject.unsubscribe();
                this.entitySubjects.delete(id);
            }
        }

        if (withEvent) {
            this.event.next({ type: 'remove', ids: ids });
        }
    }

    public add(items: T | T[], withEvent = true) {
        if (!items) {
            throw new Error(`Trying to insert a ${getClassName(this.classType)} collection item without value`);
        }

        items = isArray(items) ? items : [items];

        for (const item of items) {
            this.added.next(item);

            if (this.itemsMap.has(item.id)) {
                const index = this.items.indexOf(this.itemsMap.get(item.id) as any);
                this.items[index] = item;
                this.itemsMap.set(item.id, item);
            } else {
                this.items.push(item);
                this.itemsMap.set(item.id, item);
            }
        }

        if (withEvent) {
            this.event.next({ type: 'add', items });
        }
    }

    public remove(ids: (string | number) | (string | number)[], withEvent = true) {
        ids = isArray(ids) ? ids : [ids];
        for (const id of ids) {
            const item = this.itemsMap.get(id);
            if (!item) continue;

            this.itemsMap.delete(id);

            const index = this.items.indexOf(item);
            if (-1 !== index) {
                this.items.splice(index, 1);
            }
            if (withEvent) {
                this.removed.next(item);
            }
        }

        if (withEvent) {
            this.event.next({ type: 'remove', ids: ids });
        }
    }
}

type JSONObject<T> = Partial<T> & IdInterface;

export class JSONObjectCollection<T extends JSONObject<T>> extends Collection<T> {

}
