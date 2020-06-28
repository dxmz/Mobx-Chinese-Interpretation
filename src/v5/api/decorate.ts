import { invariant, isPlainObject } from "../internal"

export function decorate<T>(
    clazz: new (...args: any[]) => T,
    decorators: {
        [P in keyof T]?:
            | MethodDecorator
            | PropertyDecorator
            | Array<MethodDecorator>
            | Array<PropertyDecorator>
    }
): void
export function decorate<T>(
    object: T,
    decorators: {
        [P in keyof T]?:
            | MethodDecorator
            | PropertyDecorator
            | Array<MethodDecorator>
            | Array<PropertyDecorator>
    }
): T

/**
 * 最终返回经过劫持后的对象
 * Object.defineProperty(target, prop, newDescriptor)
 * 
 * 对象属性的newDescriptor是经过用户端定义的decorator包装过的描述符
 * decorate(Person, {
            name: observable,
            age: observable,
            showAge: observable,
            labelText: computed,
            setAge: action
        })
 * 
 */
export function decorate(thing: any, decorators: any) {
    process.env.NODE_ENV !== "production" &&
        invariant(isPlainObject(decorators), "Decorators should be a key value map")
    const target = typeof thing === "function" ? thing.prototype : thing
    for (let prop in decorators) {
        let propertyDecorators = decorators[prop]
        if (!Array.isArray(propertyDecorators)) {
            propertyDecorators = [propertyDecorators]
        }
        process.env.NODE_ENV !== "production" &&
            invariant(
                propertyDecorators.every(decorator => typeof decorator === "function"),
                `Decorate: expected a decorator function or array of decorator functions for '${prop}'`
            )
        const descriptor = Object.getOwnPropertyDescriptor(target, prop)
        const newDescriptor = propertyDecorators.reduce(
            (accDescriptor, decorator) => decorator(target, prop, accDescriptor),
            descriptor
        )
        if (newDescriptor) Object.defineProperty(target, prop, newDescriptor)
    }
    return thing
}
