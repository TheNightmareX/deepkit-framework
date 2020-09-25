import {entity, t} from '@deepkit/type';
import {UserCredentials} from './user-credentials';
import {Group} from './group';

@entity.name('user')
export class User {
    @t.primary.autoIncrement public id?: number;
    @t created: Date = new Date;

    @t firstName: string = '';
    @t lastName: string = '';
    @t email: string = '';
    @t.optional birthdate?: Date;

    @t logins: number = 0;

    @t.type(() => UserCredentials).optional.backReference()
    credentials?: UserCredentials;

    @t.array(() => Group).backReference({via: () => UserGroup})
    groups: Group[] = [];

    constructor(
        @t public name: string,
    ) {
    }
}

@entity.name('user-group')
export class UserGroup {
    @t.primary.autoIncrement public id?: number;
    constructor(
        @t.reference() public user: User,
        @t.reference() public group: Group,
    ) {
    }
}
